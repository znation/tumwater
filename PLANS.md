# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.


## Planned


### Agent backends, part 5/7: `role_notes` over MCP and the prompt dialect (planned 2026-10-09 by operator; requires parts 4a/7 and 4b/7 landed)

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

### Agent backends, part 6/7: subscription billing — exempt from the cap, throttled and displayed by the usage window (planned 2026-10-09 by operator; requires parts 4a/7, 4b/7 and 4e/7 landed)

**Needs review 2026-10-10 by feature: too large for one run**

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

### A numbered read half for `tumwater plan`/`bug`: `--list` (planned 2026-10-10 by plan; independent of the Agent backends series; sibling of the landed `tumwater plan --edit/--cancel` and `tumwater bug --edit/--cancel`)

**Goal.** `tumwater plan --list [--json]` and `tumwater bug --list [--json]` list the entries their
`--edit <n>` / `--cancel <n>` flags address, each numbered 1..N with its eligibility hold mark, so
an operator can see the position a command takes instead of counting `### ` headings by eye. Today
the help says `--cancel <n>` / `--edit <n>` target "the Nth entry … as `tumwater backlog` lists
it", but `tumwater backlog` prints no numbers (src/backlog/backlog-render.ts); `tumwater prompt
--list` and `tumwater questions` are already numbered, so plan/bug are the one operator queue
whose read half hides its positions. Additive only: `tumwater backlog` and its renderer stay
unchanged.

**Approach.**
1. **Shared lister.** In src/backlog/backlog-write.ts add `listAndAnnounce(root, args, command,
   fileName, sectionTitle)`, modeled on `cancelAndAnnounce`: consume one boolean `--list` (repeats
   refused with `rejectRepeatFlag`), one `--json`, tolerate `--help`/`-h`, and refuse every other
   token (positional or flag) through `rejectUnknownArgs`. No wake and no `requireReadyRepo` gate,
   matching the read-only `tumwater backlog` / `tumwater questions` precedent.
2. **Numbered view.** For plans read `plannedPlanEntries(root)`, for bugs `openBugEntries(root)`
   (backlog.ts), pair them with `backlogHolds(root).plans` / `.bugs` (backlog-eligibility.ts,
   already the parallel verdict array `tumwater backlog` renders), and build
   `{ position: i + 1, title, body, hold }`. These are the same entries, in the same order,
   that `locateEntry`/`actionableEntryRanges` number for `--edit`/`--cancel`, so one fixture can
   pin that a `--list` position and a `--cancel` position name the same entry. Prose prints a
   header line `planned features in PLANS.md:` (or `open bugs in BUGS.md:`) then
   `${n}. ${title}${holdMark(hold)}` per entry — `holdMark` (already imported by the renderer)
   keeps the marks byte-identical to `tumwater backlog` — and `no planned features` / `no open
   bugs` on an empty or missing file, exit 0, like `openQuestionList`'s `no open questions`.
   `--json` prints `{ entries: [{ position, title, body, hold }] }`, the questions --json shape
   (src/cli/question-commands.ts) with `hold` the serialized `EntryHold` (null when eligible).
3. **Dispatch.** In src/cli.ts, in `case "bug"` and `case "plan"`, intercept
   `args.includes("--list")` before the `--edit`/`--cancel`/file branches and call the shared
   lister with the section (`Open`/`BUGS.md`, `Planned`/`PLANS.md`). `--list` is flag-shaped and
   today merely rejected, so the addition takes no existing invocation.
4. **Docs.** src/cli/help.ts gains a `tumwater plan --list [--json]` stanza and a `tumwater bug
   --list [--json]` stanza, each naming the file/section and pointing at `--edit`/`--cancel`;
   README.md's prompt-table row mentions the numbered read half beside `--cancel`/`--edit`,
   mirroring how it describes `tumwater prompt --list` and `tumwater questions`.

**Files touched.**
- src/backlog/backlog-write.ts (`listAndAnnounce`; imports `plannedPlanEntries`, `openBugEntries`,
  `backlogHolds`, `holdMark`)
- src/cli.ts (the two `--list` interceptions)
- src/cli/help.ts (two stanzas)
- README.md (prompt-table wording)

Tests: test/backlog-write.test.ts — a fixture with two planned entries (one eligible, one
`requires X` blocked) and two open bugs (one refused): `plan --list` prints `1. …` / `2. … [blocked:
requires X]`, `bug --list` prints the refused bug's `[refused]`; `--json` carries positions
`[1,2]`, verbatim bodies, and the same `hold` values; `plan --cancel 2` removes exactly the
entry `plan --list` numbered 2, and `plan --edit 1` rewrites the one numbered 1; an empty section
prints the "no …" line and exits 0; a missing file too; `plan --list extra` and `plan --list
--bogus` fail naming the argument, and repeated `--list`/`--json` fail; `tumwater help plan` and
`help bug` name `--list`.

**Acceptance criteria.**
- `tumwater plan --list` prints PLANS.md `## Planned` entries numbered 1..N in file order, each
  title verbatim plus its `[refused]`/`[needs review]`/`[needs replan]`/`[blocked: requires …]`
  mark exactly as `tumwater backlog` renders it; eligible entries carry no mark.
- `tumwater bug --list` does the same for BUGS.md `## Open`; both `--json` forms print
  `{ entries: [{ position, title, body, hold }] }` with bodies verbatim.
- A position printed by `--list` is the same entry `--cancel <n>` removes and `--edit <n>`
  rewrites (pinned by one fixture), for both plan and bug.
- An empty or missing section prints the command's `no …` line and exits 0; a positional or
  unknown flag beside `--list`, or a repeated `--list`/`--json`, fails naming the argument.
- `tumwater backlog`, its Markdown render, and its `--json` payload are unchanged — the existing
  backlog-render tests pass without edits.
- `npm run test` green.

### Finish the stale code-path citation sweep across `plans/*.md` (planned 2026-10-10 by organize)

Goal. Every path-shaped token in the plan documents names a path that exists in the tree, every
`<path>:<line>` names a line the file actually has, and a module that has since split names the
module that owns the symbol beside the citation. A reader who follows a plan's citation reaches
the code it describes.

Cost it removes. The plans were audited before the landing, pi-facade, config, loop, and events
splits, so today a citation either names a module that no longer exists or a line past the file's
end. The organize loop has repaired one file per tick, and review keeps finding the pass
incomplete: the 2026-10-10 review of `plans/portability.md` named three remaining classes — a
helper pinned to the wrong landing module, a build-scope call pinned to a stale module, and line
pins past the file's end. This lands the sweep as one coherent change instead of another partial
pass.

Target structure / method.
1. Inventory: scan every `plans/*.md` for path-shaped tokens and keep the ones whose path is
   absent from the tree; separately list every `<path>:<line>` whose line is past the file's end.
2. Split-aware map: for each moved module, name the one current module that owns the cited
   symbol. A module that split into a facade plus implementations needs a per-citation symbol
   check, never a blanket rename.
3. Rewrite rule: replace the path with its current module and drop the old `:line` pin, keeping
   the symbol name in the surrounding prose. A path alone is honest; a stale number is not.
4. Historical audits: a dated "Verified as written" paragraph is a snapshot at the commit its
   heading names. Keep that commit reference; reword its line pins to symbol names rather than
   asserting a current line.

Files touched. `plans/portability.md` first (the file this sweep's review named), then every
other `plans/*.md` the inventory flags. No source or test change.

Acceptance criteria.
- The inventory over every `plans/*.md` reports no cited path absent from the tree.
- No `<path>:<line>` names a line past that file's end.
- For each split module, the module named beside a symbol exports it (checked against the
  module's export list).
- `npm run test` is green.


## Done

### Agent backends, part 4c/7: per-agent binary resolution, passthrough args and the startup gate (planned 2026-10-09 by plan; split 2026-10-09 by plan from part 4/7; requires parts 4a/7 and 4b/7 landed; done 2026-10-10 by feature)

Design: plans/agent-backends.md ("Config" back-compat; "Every seam, checked" — startup row).

**Approach.**
1. `resolveAgentBin` in src/pi/pi-bin.ts becomes `resolveAgentBin(config, agent)`:
   `TUMWATER_<ID>_BIN` env → `config.agents?.[agent]?.bin` (with `agentBin` still read for
   `pi`) → the backend's `defaultBin`. `AgentBackend.resolveBin` (src/agent/agent-backend.ts)
   resolves through it.
2. src/pi/pi-backend.ts and src/agent/claude/claude-backend.ts resolve their own entries, so
   `agents.pi.bin`/`agents.claude.bin` take effect while `TUMWATER_PI_BIN`/`TUMWATER_CLAUDE_BIN`
   keep working.
3. **Passthrough args.** `claudeBackend.invocation` passes `config.agents?.claude?.args` as
   `claudeArgs`' `args` (the builder already rejects reserved flags); pi keeps reading the
   resolved `agents.pi.args` as `piArgs`.
4. **Startup gate.** src/gates/startup-gate.ts checks the binary of every agent that `agent`
   plus any per-role or `review` selector makes an enabled seam resolve to, through the same
   `findAgentBinary`.

**Files touched.** src/pi/pi-bin.ts, src/pi/pi-backend.ts, src/agent/agent-backend.ts,
src/agent/claude/claude-backend.ts, src/agent/run-agent.ts, src/gates/startup-gate.ts,
src/config/config-views.ts.

**Acceptance criteria.**
- `agents.claude.bin` and `TUMWATER_CLAUDE_BIN` each change the binary a claude run spawns;
  `agents.pi.bin` and legacy `agentBin` resolve the pi binary.
- `agents.claude.args: ["--debug"]` reaches fake-claude's recorded argv after the harness
  flags; a reserved flag (e.g. `--verbose`, itself harness-managed) in that array fails
  validation, not the run.
- The startup gate refuses to boot when an enabled seam's agent binary is missing, and names
  that agent's binary rather than pi's.
- `npm run test` green.

**Landed.** `resolveAgentBin` takes an optional per-agent `{binEnv, defaultBin}`: the backends
pass their own fields, while the startup gate derives the reserved agents' conventional
`TUMWATER_<ID>_BIN`/default-binary values. `resolveBinFrom` is now module-private (`resolveAgentBin`
is its one caller), `resolvedAgentConfig` treats `piArgs` as optional so a bare `{}` type-checks,
and the acceptance example moved off `--verbose` to the non-reserved `--debug`. The spawn-error
path (`spawnErrorMessage` in src/agent/run-agent.ts) takes the backend so a claude config-sourced
spawn failure names `agents.claude.bin`; `agentBinConfigKey` centralizes that key for the
missing-binary and spawn-error wording. Doctor's `checkAgentBinary` still checks only pi's binary
(its agent-aware checks are part 4e/7), so the shared comments name that scope rather than claiming
the gate and doctor can never disagree.

### Agent backends, part 4f/7: agent labels and docs (planned 2026-10-09 by plan; split 2026-10-09 by plan from part 4/7; requires part 4b/7 landed; done 2026-10-10 by feature)

Design: plans/agent-backends.md ("Every seam, checked" — status/TUI/GUI/events rows).

**Approach.**
1. **Labels.** "pi default" becomes "`<agent>` default" in src/roles/role-render.ts and
   src/ui/badges.ts; the agent-qualified selector (`claude/claude-sonnet-5-5`) is written at
   the shared `modelSelectorField` seam (src/config/config-views.ts), so `tick_start`/
   `review_start` events, `model_changed`, and the status rows all carry the agent with no
   change in src/events/event-format.ts. RoleViewPayload gains `agent`
   (src/roles/role-view.ts) and the status snapshot's budget gains the fleet `agent`
   (src/status/status-data.ts) for the badge's and role view's default labels.
2. **Docs.** README "Backends": `agent`, routing, and the expected-spend note;
   docs/backends.md gains a Claude Code section and links plans/agent-backends.md. The
   "Built on pi" tagline lives inside README's protected initial-prompt block, so it is left
   unchanged.

**Files touched.** src/config/config-views.ts, src/roles/role-view.ts,
src/roles/role-render.ts, src/ui/badges.ts, src/status/status-data.ts; README.md,
docs/backends.md; test/config-views.test.ts, test/role-view.test.ts, test/badges.test.ts,
test/status-data.test.ts, test/gui-operator.test.ts.

**Acceptance criteria.**
- With `agent: "claude"` and no `model`, role-render, badges and a `tick_start` event all name
  `claude default`/`claude/claude-sonnet-5-5`; with `agent: "pi"` the strings stay
  byte-identical to before.
- README and docs/backends.md describe `agent`/`agents`, routing, and the spend expectation;
  docs/backends.md links plans/agent-backends.md.
- `npm run test` green.

### Agent backends, part 4d/7: resume and handoff under routing (planned 2026-10-09 by plan; split 2026-10-09 by plan from part 4/7; requires part 4b/7 landed; done 2026-10-10 by feature)

Design: plans/agent-backends.md ("Sessions"); the original part 4/7 "Interactions" section.

Routing lets a seam's agent change between an interrupted tick and the next one, through a
config edit or the fallback moving a claude seam to a pi fallback or back.

**Approach.**
1. `planTickStart` (src/tick/tick-resume.ts), which loop-tick.ts already calls with
   `agent: cfg.agent ?? DEFAULT_AGENT`, compares the newest session-ledger author line's `agent`
   with the tick's `agent`; a mismatch plans a `handoff` (fresh session, worktree left as is,
   `buildHandoffPrompt` from src/prompt/prompt-followup.ts) instead of a resume.
2. It reads `cfg.agent` from the same resolved view the spawn uses (`configForRole` plus the
   fallback view), not a separate resolution.

**Files touched.** src/tick/tick-resume.ts, src/loop/loop-tick.ts.

**Acceptance criteria (on fake-pi and fake-claude).**
- **Fallback flip.** An interrupted claude author tick, with the fallback active on the next
  tick, runs a fresh pi session in the unreset worktree; its prompt carries the handoff bridge,
  the revision note when a revision was in flight, and the hand-back note when one was applied.
- **Config flip mid-revision.** Changing `agent` from pi to claude while a revision is
  interrupted does the same and does not re-cherry-pick the rejected diff.
- **Mixed seams.** A conflict resolver routed to a different agent than the author writes its
  ledger line in the author's session dir; the author's next resume is then a handoff even
  though its own agent did not change.
- **Selectors.** The resume check and the spawn read the same `cfg.agent`.
- `npm run test` green.

Note (2026-10-10 by feature): this behavior was already present on main when the plan was
picked up. The session-ledger `handoff` and the newest-author-line `agent` comparison landed in
part 2/7; the backend-aware resume guard in parts 3c/3d; and the `cfg.agent` routing in part
4b/7 (`loop-tick.ts` passes `cfg.agent ?? DEFAULT_AGENT`, the fallback view's agent while an
episode is active). This tick added tests for the mixed-seam gate and the fallback-view
selector (test/tick-resume.test.ts) and moved the entry to Done; no src change was needed.

### Agent backends, part 4e/7: doctor for claude (planned 2026-10-09 by plan; split 2026-10-09 by plan from part 4/7; requires part 4b/7 landed; done 2026-10-10 by feature)

Design: plans/agent-backends.md ("Sessions" retention; "Every seam, checked" doctor row).

**Approach.** Extend src/doctor/doctor-checks.ts and src/doctor/doctor-model-checks.ts:
- claude: `claude auth status` under the scrubbed claude env must report `loggedIn`, and doctor
  prints the billing it implies (subscription type, or API key);
- the installed `claude --version` must be at least a per-model `minVersion` in the claude
  adapter (a table added to src/agent/claude/claude-backend.ts; 2.1.280 for the three tier
  defaults), and doctor prints it;
- claude selectors skip the models.json lookup in the model sweep;
- a pi provider named `claude` in the fleet warns (agent ids are reserved);
- the `off`/`minimal` `--effort` clamp is noted;
- the total size of claude's transcript dirs is reported.

**Files touched.** src/agent/agent-backend.ts (the `minVersion` seam),
src/agent/claude/claude-backend.ts, src/doctor/doctor-checks.ts,
src/doctor/doctor-model-checks.ts, src/doctor/doctor.ts.

**Acceptance criteria.**
- Doctor fails "claude auth" when fake `claude auth status` reports `loggedIn: false`.
- It fails "claude version" when fake `claude --version` reports 2.1.216 with Opus configured.
- A claude-routed config produces no models.json resolution error; a pi provider named `claude`
  yields a warning.
- Doctor reports the transcript-dir total size.
- `npm run test` green.

### Scope the failure digest to one role: `tumwater report --failures --role <id>` (planned 2026-10-10 by plan; sibling of the landed "Scope the usage report to one role: `tumwater report --role <id>`"; independent of the Agent backends series; done 2026-10-10 by feature)

**Goal.** `tumwater report --failures --role <id> [--days N]` and `tumwater report --failures
--role <id> --since <duration>` (text and `--json`) show only that role group's failure evidence —
its outcome rows, current-vs-preceding deltas, time/spend and loss causes, error/warning/
rejection/review-failure clusters, landings, and state changes — so an operator can diagnose one
loop without reading the fleet's digest. Today the combination is rejected as rival shapes
(src/report/report.ts: `failRivalShapes("report --role", "--failures", ...)`), the deferred half
of the landed usage-report scoping plan. Out of scope: the GUI `/api/failures` view and the TUI
Failures pane, which stay fleet-wide.

**Approach.**
1. **Collector scope.** In src/failure/failure-data.ts give `collectFailureReport(root, days,
   role?)`, `collectFailureReportSince(root, sinceMs, role?)`, and the shared
   `assembleFailureReport` an optional `role`. One internal helper `scopeToRole(events, base)`
   keeps events whose `baseRoleOf(eventRole(ev)) === base` — and, for the role-scoped harness
   transitions that log loop `harness` and name the affected role in `role` (a role pause, its
   streak breaker, its cap), whose `baseRoleOf(ev.role) === base` — so instance ids (`feature-2`)
   fold into their group exactly as `report --role` and the per-role cap do, and a scoped digest
   keeps the transitions that explain why the loop stopped. Apply it to the `current` and `prior`
   partitions and to the `allEvents` array the loss-cause fold reads, so every section derived
   from them narrows. Keep the unfiltered read's first event for `oldestEventDate`/window
   completeness (passed alongside `window`) so a scoped `partial` line still names log retention,
   not the role's own first event.
2. **Data shape and cache.** Add `role?: string` to `FailureReportData`, set to the base role.
   The day collector's `failureDigestCache` key is `${root}\u0000${days}`; append the base role so a
   scoped and a fleet digest cannot collide (the `--since` collector is not memoized).
3. **CLI.** In src/report/report.ts read `--role` through the existing `parseRoleScope`,
   delete the `--failures` rival-shape guard, and pass the role to both collectors (day and
   `--since`, text and `--json`). src/cli.ts's `case "report"` already admits `ROLE_FLAG` and
   `--failures`, so no gate change is needed.
4. **Render.** In src/failure/failure-render.ts `renderFailureMarkdown`, print a `role: <base>`
   line under the window line when `data.role` is set (mirroring report-render.ts's role line);
   when scoped, retitle the `## Fleet state changes` section to `## State changes` so it does not
   claim fleet scope. Section titles otherwise stay fleet-neutral.
5. **Docs.** src/cli/help.ts adds `--role <id>` to the `--failures` stanzas for both `--days` and
   `--since`; README.md's report row drops the "not combinable with `--failures`" clause and
   states that `--role` scopes the failure digest too.

**Files touched.**
- src/failure/failure-data.ts (optional `role`; `scopeToRole`; cache key; `FailureReportData.role`)
- src/failure/failure-render.ts (`role` line; scoped state-changes heading)
- src/report/report.ts (`parseRoleScope`; remove `failRivalShapes`; pass role)
- src/cli/help.ts (usage)
- README.md (report row wording)

Tests: test/failure-render.test.ts — a two-role fixture (`feature` and `qa` tick_end, warnings, a
rejection, a landed merge, and a `role_streak_paused`/`role_cap_paused` pair on loop `harness`)
collected with `role: "qa"` prints only `qa`'s outcome, delta, time-spend, cluster, landing and
state-change lines and carries the `role: qa` header with the `## State changes` heading, while
the same fixture with no role still shows both roles and `## Fleet state changes`; an instance id
(`feature-2`) scopes with its base `feature`; a role with no events reports the empty window; a
scoped partial window names the whole log's oldest event, not the role's first. test/report.test.ts
— `runCli(root, "report", "--failures", "--role", "qa")` succeeds (no rival-shape error) and names
`qa`; the `--json` payload carries `"role": "qa"`; `--role bogus` still fails with the shared
unknown-role message; `report --help` names the combination.

**Acceptance criteria.**
- `tumwater report --failures --role qa` (text) prints `role: qa` under the window line and shows
  only `qa`'s rows in Outcome by role, Deltas, Time and spend, loss causes, error clusters, and
  landings; the state-changes section is titled `## State changes`.
- `tumwater report --failures --role qa --since 90m` does the same over the trailing window, and
  `--json` carries `"role": "qa"`.
- `tumwater report --failures` without `--role` is unchanged — the existing failure-render and
  failure-time-spend tests pass without edits — and the GUI/TUI failure surfaces are untouched.
- `--role bogus` fails with the shared unknown-role message; `report --role qa --failures` no
  longer fails as rival shapes; `tumwater help report` documents the combination; README no
  longer says it is rejected.
- `npm run test` green.

### Warn before a loop reaches its own daily cap: the `role_cap_warning` event (planned 2026-10-09 by plan; independent of the Agent backends series; done 2026-10-10 by feature)

**Goal.** A loop whose local-day spend crosses 80% of its own `maxDailyCostUsdPerRole` cap logs
one `role_cap_warning` event while it is still ticking, so the configured `notify` hook can page
the operator while there is still room to raise the cap. It is the per-role twin of the fleet's
`budget_warning` (src/gates/budget-gates.ts), which the per-role cap does not have today: the
first event a per-role cap emits is `role_cap_paused`, when the loop already stops. Scheduling
is untouched — the warning is observability only.

**Context.** src/gates/role-cap-gates.ts already holds the pure verdict and the edge-triggered
bookkeeping (`roleCapVerdicts`, `newRoleCapGateState`, `pollRoleCapGate`), so the warning is one
more band in the same state machine. `budgetWarning` (src/budget/budget.ts) is the fleet gate's
80% predicate (`spentUsd >= cap * BUDGET_WARNING_FRACTION`, false for absent/non-finite/≤0 caps),
and a per-role warning reuses it rather than minting a second threshold. The per-role figures are
the group's summed `verdict.spentUsd` against the base role's cap, exactly as `role_cap_paused`
reads them, so instances (`feature`, `feature-2`) warn as one group.

**Approach.**
1. src/gates/role-cap-gates.ts: `RoleCapGateState` gains `warned: Set<string>` (base roles already
   warned in the current band); `newRoleCapGateState` initializes it. In `pollRoleCapGate`'s
   per-base loop, after the `over`/resume branch, compute `const cap = caps?.[base]` and
   `const warn = !verdict.over && cap !== undefined && budgetWarning({ spentUsd: verdict.spentUsd,
   capUsd: cap })` (import `budgetWarning` beside `dailyCost`/`todayStamp`). On a
   `warn && !state.warned.has(base)` crossing, `logEventBestEffort(root, { loop: "harness", type:
   "role_cap_warning", role: base, spentUsd: verdict.spentUsd, capUsd: cap })` and add `base` to
   `warned`; when `!warn`, delete `base`. The delete re-arms the warning after spend falls back
   below (a raised cap or a new day), and skipping `over` polls matches the fleet gate's "warn
   only while open" rule: a poll that jumps straight to the cap logs only `role_cap_paused`.
2. src/events/events.ts: add `| "role_cap_warning"` to the `HarnessEvent` type union beside
   `role_cap_paused`, with the carries-`role`/`spentUsd`/`capUsd` comment.
3. src/events/event-format.ts: a `case "role_cap_warning":` beside the `budget_warning` and
   `role_cap_paused` cases — `role ${textOr(e.role)} at ${budgetPhrase(e.spentUsd, e.capUsd)} of its
   daily cap — it keeps ticking; raise or remove the cap in tumwater.json before it pauses`.
4. src/events/notify.ts: add `"role_cap_warning"` to `NOTIFY_EVENT_TYPES` with its comment, so a
   configured notify command pages on it like the fleet `budget_warning`.
5. src/ui/tone.ts: add `"role_cap_warning"` to `PROBLEM_EVENTS` beside `budget_warning`.
6. docs/how-it-works.md: the `maxDailyCostUsdPerRole` bullet in "Spend and pausing" gains the 80%
   warning sentence, mirroring the `maxDailyCostUsd` bullet's.

**Files touched.**
- src/gates/role-cap-gates.ts (`RoleCapGateState`, `newRoleCapGateState`, `pollRoleCapGate`)
- src/events/events.ts (type union)
- src/events/event-format.ts (`formatEvent` case)
- src/events/notify.ts (`NOTIFY_EVENT_TYPES`)
- src/ui/tone.ts (`PROBLEM_EVENTS`)
- docs/how-it-works.md

Tests: test/role-cap-gates.test.ts — an 80%-crossing poll over a two-step spend logs exactly one
`role_cap_warning` with `{role, spentUsd, capUsd}`, returns no paused id and logs no
`role_cap_paused`; a drop below 80% then a re-crossing logs a second warning; a single poll that
jumps from below 80% to at/over the cap logs only `role_cap_paused`; an absent/0 cap warns
nothing. test/event-format-fleet.test.ts — the rendered line names the role, the spend against
the cap, and that the loop keeps ticking. test/notify.test.ts — extend the pinned
`NOTIFY_EVENT_TYPES` allowlist assertion with `role_cap_warning`.

**Acceptance criteria.**
- A base role's summed local-day spend at or past 80% of a finite positive
  `maxDailyCostUsdPerRole` entry, while still below the cap, logs exactly one `role_cap_warning`
  carrying `role`, `spentUsd`, and `capUsd`; the returned paused set stays empty and no
  `role_cap_paused` is logged for that role.
- Spending the remaining band in one poll to reach or exceed the cap logs only `role_cap_paused`
  on that poll, and dropping below 80% before re-crossing logs the warning again.
- A cap of 0, undefined, or absent logs no warning, and the director stays exempt exactly as it is
  from `role_cap_paused`.
- `tumwater logs` renders the event naming the role, its spend against its cap, and that the loop
  keeps ticking; `NOTIFY_EVENT_TYPES` includes it; docs/how-it-works.md names the per-role warning.
- `npm run test` green.

### Pause and resume the whole fleet from `tumwater tui`: the `Ctrl+F` toggle (planned 2026-10-10 by plan; independent of the Agent backends series; done 2026-10-10 by feature)

**Goal.** `Ctrl+F` in `tumwater tui` toggles the fleet pause through the same
`pauseFleet`/`resumeFleet` marker writers `tumwater pause`/`resume` and the dashboard's
`/api/pause` call, so an operator watching the terminal can hold or release the whole fleet
without a second terminal. Today the TUI shows the fleet-pause alert (`fleetAlerts`' `paused`
entry, src/ui/fleet-alerts.ts) and offers the per-loop `Ctrl+P`, but no key writes the fleet
marker; the GUI already has a pause control and its alert carries a Resume action the TUI
cannot offer.

**Context.** src/ui/tui/tui-keys.ts's `createTuiKeys` already imports `pausedRoles`/`pauseRole`/
`resumeRole` from src/fleet/fleet-state.ts, where `pauseFleet`, `resumeFleet` and the reader
`isFleetPaused` live as the single marker writers shared by src/operator/operator-commands.ts's
`cmdPause`/`cmdResume` and src/gui/gui-endpoint-commands.ts's `/api/pause` — so the TUI cannot
drift on marker format or idempotence. Confirmation wording reuses the shared base lines
`fleetPausePhrase()`/`fleetResumePhrase()` (src/text/phrases.ts), which the event feed and the
failure digest already share. `Ctrl+F` is free: the handler's only ctrl keys are D, C, B, P, A,
W, R, N and T.

**Approach.**
1. src/ui/tui/tui-keys.ts: import `isFleetPaused`, `pauseFleet`, `resumeFleet` from
   src/fleet/fleet-state.ts and `fleetPausePhrase`, `fleetResumePhrase` from src/text/phrases.ts.
   Add a `Ctrl+F` branch after the `Ctrl+B` branch and before the per-loop-controls branch,
   guarded `!budgetMode && !rolePromptFor` so it never fires while an editor holds the prompt
   line (the same inertness the per-loop keys have): read `const paused = isFleetPaused(root)`;
   when paused call `resumeFleet(root)` and flash
   `changed ? fleetResumePhrase() : "fleet was not paused"`; otherwise call `pauseFleet(root)`
   and flash `changed ? fleetPausePhrase() : "fleet is already paused"`. Wrap it in the same
   `try`/`catch` → `flashError` other disk-writing branches use, then `deps.requestRender()` so
   the next frame's `fleetAlerts` shows or drops the pause alert.
2. src/ui/tui/tui-frame.ts: the Activity/default `hintLine` branch gains `["Ctrl+F", "pause fleet"]`
   after `["Ctrl+B", "daily cap"]`.
3. docs/how-it-works.md's Operator notes TUI bullet: name `Ctrl+F` as the fleet pause/resume
   toggle (in-flight ticks finish; the director keeps running), mirroring the pause alert's
   detail line.

**Files touched.**
- src/ui/tui/tui-keys.ts (`createTuiKeys`'s dispatch)
- src/ui/tui/tui-frame.ts (`hintLine`)
- test/tui-operator-keys.test.ts, test/tui-frame.test.ts
- docs/how-it-works.md

Tests: test/tui-operator-keys.test.ts (the operator-controls topic slice, which already imports
`pauseFleet`/`pausedRoles` and builds its fake TTY with `makeTuiRepo`/`withTui`) — `Ctrl+F` makes
`isFleetPaused(repo)` true and flashes `fleet paused — role loops stop starting new ticks`, the
frame then matches `/The fleet is paused/`; a second `Ctrl+F` clears it (`isFleetPaused` false)
and flashes `fleet resumed — role loops tick again`; while budget-edit mode or role-prompt mode
holds the line, `Ctrl+F` writes no marker. test/tui-frame.test.ts's Activity hint assertion gains
`Ctrl+F pause fleet`.

**Acceptance criteria.**
- `Ctrl+F` toggles the fleet pause marker through `pauseFleet`/`resumeFleet`; no new state is
  introduced — the presence of the existing marker is what the scheduler, `tumwater status` and
  the GUI read.
- The flash carries the shared `fleetPausePhrase`/`fleetResumePhrase` wording; a toggle that
  changes nothing flashes the `already paused`/`was not paused` line, the CLI's changed-state
  contract.
- The next render shows the fleet-pause alert when the marker is set and drops it when lifted;
  the per-loop `Ctrl+P` and its fleet-pause interplay note are unchanged.
- `Ctrl+F` is inert while the budget editor or the role-prompt editor holds the prompt line.
- docs/how-it-works.md names the key, and `npm run test` is green.

### A Pending view in `tumwater tui` matching `tumwater diff` (planned 2026-10-10 by plan; sibling of the just-landed "A History view in `tumwater tui`"; independent of the Agent backends series; done 2026-10-10 by feature)

**Goal.** `Ctrl+T` in `tumwater tui` gains a fleet-wide **Pending** pane showing the unlanded-change
roster `tumwater diff` prints — one line per loop holding work, or `no pending changes` — so the
terminal can read what each loop holds between its commit and its merge without leaving the TUI.
This is the last view parity gap: `docs/how-it-works.md`'s Operator notes already say the TUI
"names its views the same way" and list only Activity, Transcript, Backlog, Usage, Failures, and
History, while the dashboard has a Pending view (PLANS.md ## Done, "GUI Pending view",
commit 5ecdaaa6) and the just-landed TUI History entry noted the dashboard's History "(and
Pending)" had no terminal counterpart. The pane reuses the existing collector and renderer —
`collectFleetChanges` (src/change/change-data.ts) and `renderFleetChange` (src/change/change-render.ts)
— so the TUI, the CLI, and `/api/diff` cannot disagree about the roster.

**Context.** The Usage/Failures/History panes are the template: a text cache `paneCache` computed
once per activation by the `Ctrl+T` handler (src/ui/tui/tui-keys.ts) and re-windowed each frame by
`paneBody` through `entryBodyWindow` (src/ui/tui/tui-pane.ts). History's read is synchronous;
`collectFleetChanges` is async (it awaits git plumbing behind `collectRoleChange`), so the Pending
branch kicks the collector off fire-and-forget from the sync handler, caches the rendered text when
it resolves, and calls `deps.requestRender()` — guarding on the view index so a resolution after the
operator cycled away cannot overwrite the new pane's cache. This is the same async-collector call
the GUI's `/api/diff` makes, reached directly rather than over HTTP.

**Approach.**
1. src/ui/tui/tui-frame.ts: add `{ kind: "pending" }` to `TuiView`; append `["pending", "Pending"]`
to `tabStrip`'s tab list **after** History, so the existing Usage/Failures/History indices and
their tests do not move; give `hintLine` a Pending branch with the Usage/Failures/History keys
(`Enter send · ↑↓ history · PgUp/PgDn scroll · Ctrl+T next view · Ctrl+D quit`); update the
`TuiView` and `tabStrip` doc comments to name Pending.
2. src/ui/tui/tui-pane.ts: a `pane.kind === "pending"` branch mirroring the history branch —
window `state.paneCache` through `entryBodyWindow(state.paneCache ?? "", state.paneScroll,
eventBudget, width)` and return `emptyNote: "(loading pending changes…)"` (the cache is null only
until the collector resolves); enumerate Pending in the module header comment.
3. src/ui/tui/tui-keys.ts: (a) change the cycle modulus to `roleIds.length + 6` and the pending
index to `roleIds.length + 5`, updating the cycle comment; (b) add an optional seam
`collectPending?: (root: string) => Promise<FleetChangeView>` to `TuiKeysDeps`, defaulting to
`collectFleetChanges` (imported from src/change/change-data.ts); (c) in the `Ctrl+T` handler, when
the new view is the pending index, leave `paneCache` null and `void deps.collectPending(root).then`:
if `view === roleIds.length + 5` still holds, set `paneCache = renderFleetChange(fleet)` (import
`renderFleetChange` from src/change/change-render.ts; name the resolved `FleetChangeView`
parameter `fleet`, since `view` is the handler's own view index) and call `deps.requestRender()`; on rejection
call `flashError(err)` and `deps.requestRender()` (the default collector's doc promises it degrades
rather than throws, so this only covers an injected seam). The existing `paneScroll = 0` reset and
the `view >= roleIds.length + 2` PgUp/PgDn condition already cover the new pane.
4. src/ui/tui/tui.tsx: map `view === roleIds.length + 5` to `{ kind: "pending" }` in the pane
assembly.
5. docs/how-it-works.md's Operator notes TUI bullet: add Pending to the `Ctrl+T` cycle sentence
(Activity, each loop's Transcript, Backlog, Usage, Failures, History, Pending).

**Files touched.**
- src/ui/tui/tui-frame.ts (`TuiView`, `tabStrip`, `hintLine`, comments)
- src/ui/tui/tui-pane.ts (`paneBody`, comment)
- src/ui/tui/tui-keys.ts (cycle modulus, `collectPending` seam, async pending cache)
- src/ui/tui/tui.tsx (view mapping)
- docs/how-it-works.md

Tests: extend test/tui-frame.test.ts's tab-strip and hint assertions for the Pending tab last;
extend the view-cycle test in test/tui-keys.test.ts to reach the pending index and page it, and add
one test that injects a `collectPending` resolving a fixed `FleetChangeView` — after the promise
settles the pane's `paneCache` is `renderFleetChange`'s text and a render was requested, and
cycling away drops the cache.

**Acceptance criteria.**
- `Ctrl+T` cycles Activity → each loop's Transcript → Backlog → Usage → Failures → History →
Pending → Activity, and the tab strip shows `[Pending]` last.
- The Pending pane shows the fleet-wide `renderFleetChange(await collectFleetChanges(root))` text:
one line per role holding unlanded work (`role: N commits ahead of <main>[, M uncommitted files]`),
or `no pending changes` when the fleet holds none; entering the pane recomputes it and the pane
repaints when the collector resolves.
- PgUp/PgDn page the pane and clamp at both ends, exactly as Usage/Failures/History page their
text; leaving the pane before the collector resolves does not cache onto the view the operator
moved to.
- `tumwater diff`, `tumwater diff --json`, the GUI Pending view, and `tumwater history` are
unchanged (`collectFleetChanges`, `renderFleetChange`, and `TickRow` are untouched).
- `npm run test` green.


### Agent backends, part 4b/7: `agent`, selector routing and per-tier claude defaults (planned 2026-10-09 by plan; split 2026-10-09 by plan from part 4/7; requires part 4a/7 landed; done 2026-10-10 by feature)

Design: plans/agent-backends.md ("Config: `agent`, `agents`, and backend-namespaced selectors";
"Decisions" 5).

Goal: claude becomes selectable.

**Approach.**
1. **`agent`.** Add `agent?: "pi" | "claude"` (default `"pi"`) to src/config/config-schema.ts
   and `defaultConfig()`.
2. **Routing.** A pure helper beside `parseModelSelector` in src/config/model-selector.ts
   resolves a `ModelSelector` plus `agent` to a backend id and, when no model is set, that
   backend's tier default. `withModelOverrides` in src/config/config-views.ts uses it to set
   `ResolvedModelConfig.agent`: the provider segment is a registered agent id → that agent; any
   other provider → pi; a bare id → top-level `agent`; no `model` key at all → the backend's
   tier default from `AGENT_DEFAULT_MODELS` below. Once `model` is set, today's tier
   inheritance is unchanged.
   `configForRole`, `reviewRunConfig`, `reviewConfig`, `resolverConfig` and the fallback views
   (`fallbackRoleConfig`) all carry the resolved `agent`.
3. **Defaults.** The tier-default table lives in src/config/model-selector.ts as
   `AGENT_DEFAULT_MODELS`, read by `routeModel` (the pure config layer resolves seam models and
   must not import the runtime backend registry): claude supplies `small: claude-haiku-5-5`,
   `default: claude-sonnet-5-5`, `strong: claude-opus-5-5`, pi none. They stay out of
   `defaultConfig()`, so a config that never set `model` does not grow a model key.
4. **Free-ness.** `fallbackModelFree` and `fleetModelsFree` (src/pi/pi-models.ts) consult the
   backend a selector routes to. In this part a claude-routed selector is never free, matching
   the safe direction `pairFree` already takes for an unresolvable pair; part 6/7 makes
   subscription billing free. The budget gate (src/gates/budget-gates.ts) and the status pause
   set (src/status/status-data.ts) judge fallback pairs with the same predicate, so neither
   engages a claude-routed fallback the badge would not call free.

**Files touched.** src/config/config-schema.ts, model-selector.ts, config-views.ts, config.ts;
src/agent/claude/claude-backend.ts; src/pi/pi-models.ts; src/gates/budget-gates.ts,
src/status/status-data.ts.

**Acceptance criteria.**
- **One line.** `{ "agent": "claude" }` runs author ticks on fake-claude with
  `--model claude-sonnet-5-5`, the reviewer/plan/conflict-resolver with
  `--model claude-opus-5-5`, and readme with `--model claude-haiku-5-5`;
  `{ "agent": "claude", "model": "claude-sonnet-5-5" }` puts every seam on Sonnet.
- **Mixed.** `{ "agent": "claude", "fallback": "omlx/Qwen…" }` runs the fallback on fake-pi
  with `--provider omlx`.
- **Per-seam.** `{ "review": { "model": "claude/claude-opus-5-5:high" } }` under `agent: "pi"`
  runs only the reviewer on claude, with `--effort high`.
- **Legacy.** A config with `agentBin` + `piArgs` and no `agent`/`model` produces byte-identical
  pi argv.
- **Free-ness.** A claude-routed `fallback` is rejected as not free, exactly like a priced pi
  pair.
- `npm run test` green.

Note (2026-10-10 by feature): the tier-default table lives in
src/config/model-selector.ts as `AGENT_DEFAULT_MODELS` and is the single source; `routeModel`
reads it directly because the pure config layer resolves seam models and must not import the
runtime backend registry, so `AgentBackend` carries no tier-default field. The config field is
typed `string` and validated against the reserved `AGENT_IDS` (`pi`, `claude`) so a test or
later backend can register an id outside the schema's set. Doctor's model sweep is not
agent-aware yet — a claude-routed config is read there as a bare pi model until part 4e/7.

### Agent backends, part 4a/7: the `agents` config section, legacy mapping, reserved flags and writers (planned 2026-10-09 by plan; split 2026-10-09 by plan from part 4/7, which feature judged too large for one run; requires part 3d/7 landed; done 2026-10-09 by feature)

Design: plans/agent-backends.md ("Config: `agent`, `agents`, and backend-namespaced selectors", "Back-compat").

Stores the backend section only; routing lands in part 4b/7, so this part adds no seam behavior.

**Approach.**
1. **Schema.** `agents?: Record<string, { bin?: string; args?: string[] }>` sits in
   src/config/config-schema.ts beside `agentBin`/`piArgs` (with an `AgentConfig` type and
   `AGENT_KEYS`), and `defaultConfig()` in src/config/config.ts gains an empty `agents` map.
   The effective `agents.pi` reads the legacy `agentBin`/`piArgs` through config-views.ts's pure
   `resolvedAgentConfig` — read, not written back into `config.agents`, because a load-time
   mirror would leak a duplicate spelling into every later config write that re-serializes the
   merged config.
2. **Validation.** src/config/config-validation.ts (with the helpers in config-field-checks.ts)
   accepts an `agents` entry only as an object with an optional non-empty `bin` string and an
   optional string `args` array; setting both spellings of one field (`agentBin` and
   `agents.pi.bin`, `piArgs` and `agents.pi.args`) is an error on the raw-file pass;
   `agents.claude.args` and `agents.pi.args` elements that repeat a harness flag
   (`HARNESS_CLAUDE_FLAGS`, exported by src/agent/claude/claude-args.ts, and `HARNESS_PI_FLAGS`)
   error exactly as `piArgs` does, naming the flag.
3. **Writers.** `agents.<id>.bin` and `agents.<id>.args` join config-write.ts's dotted-key merge
   logic (one field at a time, as `maxDailyCostUsdPerRole.<id>` merges one entry); the new-form
   pi setters drop the legacy alias and a legacy `agentBin`/`piArgs` set drops the matching new
   field, so a file never holds both. `EDITABLE_CONFIG_KEYS` gains the whole `agents` section,
   which the GUI settings mirror (src/ui/gui/gui-client-settings.ts) edits as JSON.
4. **Examples.** tumwater.example.json shows `agents`; the schema and resolver doc comments note
   that `agentBin`/`piArgs` are its legacy spelling.

**Files touched.** src/config/config-schema.ts, config-validation.ts, config-write.ts,
config-editable-keys.ts, config.ts, config-views.ts, config-example.ts;
src/cli/config-commands.ts; src/agent/claude/claude-args.ts;
src/ui/gui/gui-client-settings.ts; tumwater.example.json; test/config-validation.test.ts,
test/config-write.test.ts, test/config-views.test.ts, test/gui-client-settings.test.ts,
test/gui-endpoints.test.ts.

**Acceptance criteria.**
- **Legacy.** A config with `agentBin` + `piArgs` and no `agents` resolves those values under
  `agents.pi` through `resolvedAgentConfig`; the pi backend's resolved bin and argv stay
  byte-identical to before (the seams still read `agentBin`/`piArgs`).
- **Both forms.** Setting `agentBin` and `agents.pi.bin`, or `piArgs` and `agents.pi.args`, is a
  load-time validation error (the raw pass — the merged config always carries a default
  `piArgs`, so only the file's own keys can tell an explicit legacy value from the default).
- **Reserved.** `agents.claude.args: ["--model", "x"]` is a validation error naming the flag.
- **Writers.** `tumwater config set agents.claude.args '["--debug"]'` writes the array and
  `tumwater config set agents.claude.bin /opt/claude` the string (each merges one field);
  `config unset` removes them.
- **Inert.** No seam reads `agents` yet: selection and spawning are unchanged.
- `npm run test` green.

### Scope the usage report to one role: `tumwater report --role <id>` (planned 2026-10-09 by plan; done 2026-10-09 by feature; completes Stage 2 of docs/feature-per-role-spending.md; independent of the Agent backends series)

**Goal.** `tumwater report --role <id> [--days N]` and `tumwater report --role <id>
--since <duration>` (text and `--json`) report only that role's interactive usage and landed
commits, so an operator running per-role caps (`maxDailyCostUsdPerRole`, already landed) can
see where one role's spend went without eyeballing the fleet's per-role lines. This is the last
unlanded piece of docs/feature-per-role-spending.md's Stage 2: the per-role cap and the
dashboard's per-role cost already exist; only the scoped report is missing. Explicitly out of
scope here: scoping the failure digest and the dashboard/TUI report views, which keep their
fleet-wide data. The failure digest was scoped separately by the entry "Scope the failure
digest to one role: `tumwater report --failures --role <id>`" (done 2026-10-10), which removed
the `--role`/`--failures` rival-shape rejection.

**Approach.**
1. **Per-role output tokens.** In src/report/report-data.ts `foldUsageEvent`'s `tick_end`
branch, add `addTo(target.tokensByRole, role, tokens)` beside the existing `ticksByRole` and
`costByRole` bumps; add `tokensByRole: Record<string, number>` to `UsageFold` and `DayFold`,
initialized to `{}` in `dayFoldFor` and in `collectReportSince`'s accumulator. The map stays off
`ReportDay`/`SinceReport`, so no existing data-shape assertion changes.
2. **Scope both collectors.** Give `collectReport(root, days, role?)` and
`collectReportSince(root, sinceMs, role?)` an optional `role`. When set, each day/accumulator
derives its numbers from the fold's per-role maps instead of the fleet fields: `tokensOut`,
`costUsd`, `ticksByRole`/`costByRole`/`commits`/`commitsByRole` narrowed to that role's base —
instance keys fold into their group, matching the base-role cap — the work/maintenance split
from `commitTier(base)`, and
the landing fields plus `featuresDone`/`bugsFixed` left at zero (landing runs belong to the
landing slot, and backlog tallies are day-granular file dates with no role). Both payloads gain
`role?: string`; the fleet callers (src/report/report.ts, src/ui/tui/tui-keys.ts,
src/gui/gui-endpoints.ts) pass no third argument and are unchanged.
3. **CLI.** src/report/report.ts calls `parseRoleScope(root, args)` (src/cli/cli-args.ts — the
existing read-only role-id validator, custom loops included) and passes it to the collectors;
`--role` with `--failures` failed through the existing `failRivalShapes` wording (usage-report
scoping only) at the time; the failure-digest scoping entry removed that guard on 2026-10-10.
src/cli.ts's `case "report"` `rejectUnknownArgs` spec gains `ROLE_FLAG`;
src/cli/help.ts adds `[--role <id>]` to the `--days` and `--since` stanzas.
4. **Render.** In src/report/report-render.ts, when `data.role` is set: print a `role: <id>` line
under the window line; pass an empty tail to `totalsLine` in `renderReportMarkdown` so the fleet
`features done / bugs fixed` cells are dropped; and print one shared module constant (e.g.
`ROLE_SCOPE_NOTE`) to both renders naming that landing runs and backlog tallies are fleet-wide
and omitted. The landing-share line already disappears (zero means absent), and the fleet render
paths — including the TUI Usage pane and `/api/report` — are untouched.

**Files touched.**
- src/report/report-data.ts (fold maps; optional `role` on both collectors)
- src/report/report-render.ts (`role` line, scoped totals tail, `ROLE_SCOPE_NOTE`)
- src/report/report.ts (`parseRoleScope`, pass `role`, `--failures` rival)
- src/cli.ts (report gate admits `--role`)
- src/cli/help.ts (usage)

Tests: test/report-data.test.ts — scoped day and `--since` collectors over a two-role event set
(only the named role's tokens/ticks/cost/commits, landing and backlog cells zero), plus the same
fixture without `role` still totalling all roles; test/report.test.ts — the scoped render omits
the backlog tail and prints the scope note, `runCli(root, "report", "--role", "feature")` prints
only that role, `--role bogus` fails with the shared unknown-role message, `--role feature
--failures` failed as rival shapes at the time (that guard was removed 2026-10-10 when the
failure digest gained `--role`), a trailing `--role` names the missing-value error, and
`report --help` names the flag.

**Acceptance criteria.**
- `tumwater report --role feature --days 14` totals and every day row count only `feature`'s
`tick_end` tokens/ticks/cost and `feature`'s `merged` commits; the Ticks/Cost/Commits by role
lines name only `feature`; the header carries `role: feature` and the report states that landing
runs and backlog tallies are omitted; no landing-share line prints.
- `tumwater report --role feature --since 90m` does the same over the trailing window, and
`--json` carries `"role": "feature"`.
- `tumwater report` (text and `--json`) without `--role` is unchanged — every existing
report-data and report render test passes without edits.
- `tumwater report --role feature --failures` failed with a rival-shape error naming both flags
at the time (the guard was removed 2026-10-10 when the failure digest gained `--role`);
`--role bogus` fails with the shared unknown-role message; `tumwater help report` names `--role`.
- `npm run test` green.

### Show backlog entry eligibility holds in the GUI and TUI backlog lists (planned 2026-10-09 by plan; done 2026-10-09 by feature; sibling of "Mark why a backlog entry is held in `tumwater backlog`")

**Goal.** The dashboard's backlog panel and the TUI's project-status pane mark each held entry
beside its title with the same `[blocked: requires …]`, `[refused]`, `[needs review]`, or
`[needs replan]` tag `tumwater backlog` prints, so an operator watching the dashboards reads why
a plan or bug is skipped instead of inferring it from its heading text — the terminal and the
browser show the same thing both read in `tumwater backlog`.

**Context.** `entryHold`, `holdMark` and `backlogHolds` (src/backlog/backlog-eligibility.ts)
are the one decision every surface should share; today only the CLI uses them (`cli-query-
commands.ts` spreads `backlogHolds` into `backlogPayload`). `statusPayload`
(src/ui/status-payload.ts) exposes bare `plans`/`bugs` title arrays, so the GUI list
(`renderBacklog`, src/ui/gui/gui-client-fleet.ts) prints `splitTitle(title).title` unmarked. The
TUI backlog pane (`paneBody`'s backlog branch, src/ui/tui/tui-pane.ts) and its helpers
(`labeledBacklogEntries`, `backlogLines`, src/ui/tui/tui-backlog.ts) read
`plannedPlanEntries`/`openBugEntries` and print `e.title` unmarked in both list and entry mode.
No new collection or state: the marks are already computed from the headings.

**Approach.**
1. src/ui/status-payload.ts: read `backlogHolds(root)` once and add two arrays parallel to
today's `plans` and `bugs` — `planHolds: string[]` and `bugHolds: string[]`, each
`holdMark(holds.plans[i])`/`holdMark(holds.bugs[i])` (empty string when eligible). The arrays
stay aligned because `backlogHolds` and `plannedPlans`/`openBugs` both walk the same
`sectionEntries` file order.
2. src/ui/gui/gui-client-fleet.ts `renderBacklog`: for the plans and bugs tabs, read the
matching `d.planHolds`/`d.bugHolds` entry and, when non-empty, append
`<span class='li-meta'>` + `esc(mark.trim())` inside the entry's `<button class='li-open
backloglink'>` after the title span — the title/meta split and the click's `data-file` /
`data-index` are unchanged, and the questions tab carries no holds.
3. src/ui/tui/tui-backlog.ts: add an exported `backlogMarks(root): { plans: string[]; bugs: string[] }`
that maps `plannedPlanEntries`/`openBugEntries` through
`holdMark(entryHold(e, plannedEntries))` exactly as `backlogHolds` does; give each
`labeledBacklogEntries` row a `mark: string` field from it (empty for questions).
`backlogLines` keeps its `string[]` signature and tests.
4. src/ui/tui/tui-pane.ts backlog branch: pass `entry.title + marks.plans[i]` (and the bug
equivalent) into `backlogLines` for list mode, and `${e.label}: ${e.title}${e.mark}` for the
entry-mode header line, so both modes read the mark.

**Files touched.**
- src/ui/status-payload.ts (`planHolds`, `bugHolds`)
- src/ui/gui/gui-client-fleet.ts (`renderBacklog`)
- src/ui/tui/tui-backlog.ts (`backlogMarks`, `labeledBacklogEntries`)
- src/ui/tui/tui-pane.ts (`paneBody` backlog branch)

Tests: a case in test/status-payload.test.ts seeding PLANS.md/BUGS.md with a blocked and a
refused entry and asserting `planHolds`/`bugHolds` align with `plans`/`bugs`; a case in
test/gui-client-fleet.test.ts rendering `renderBacklog` with `planHolds` and asserting the tag
rides beside the title while an eligible row is byte-identical to today's; cases in
test/tui-backlog.test.ts for `backlogMarks` and the entry-mode header line.

**Acceptance criteria.**
- `GET /api/status` returns `planHolds` and `bugHolds` parallel index-for-index with `plans`
  and `bugs`; an eligible entry's mark is the empty string.
- The GUI Plans/Bugs tabs show `[blocked: requires …]` beside a blocked entry's title and the
  refusal/needs-review/needs-replan tags beside those, with eligible rows and the Questions tab
  unchanged; clicking a held row still opens its entry by index.
- The TUI backlog list and entry mode show the same mark beside the same title, and an eligible
  entry's line is unchanged.
- `tumwater backlog` output is unchanged (the mark functions are untouched).
- `npm run test` green.

### A History view in `tumwater tui` matching `tumwater history` (planned 2026-10-09 by plan; done 2026-10-09 by feature)

**Goal.** `Ctrl+T` in `tumwater tui` gains a fleet-wide **History** pane showing the completed-tick
rows `tumwater history` prints, newest first — the same rows the dashboard's History view renders —
so the terminal can read each loop's recent results, durations, and usage without leaving the TUI.
Today `TuiView` (src/ui/tui/tui-frame.ts) has Activity, Transcript, Backlog, Usage and Failures;
the dashboard's History (and Pending) have no terminal counterpart, so `docs/how-it-works.md`'s
claim that the TUI "names its views the same way" is not yet true. No new collection:
`readTickRows` (src/history/history-data.ts) already builds these rows for the CLI and
`/api/history`; this only renders them.

**Context.** The Usage/Failures panes are the template: their body is a text cache `paneCache`
computed once per activation by the `Ctrl+T` handler (src/ui/tui/tui-keys.ts) and re-windowed each
frame by `paneBody` through `entryBodyWindow` (src/ui/tui/tui-pane.ts). History is the same shape,
with `readTickRows(root, HISTORY_DEFAULT_TICKS, null)` as the per-activation read
(`HISTORY_DEFAULT_TICKS` is exported from history-data.ts). The CLI's column padding lives in
src/history/history.ts and is not pulled over: the pane has no full terminal width to align
against, so its one-line-per-row format is compact and the parity claim is about the rows and
fields, not byte-identical layout.

**Approach.**
1. New `tui-history.ts` (in src/ui/tui/): `historyPaneText(rows: readonly TickRow[]): string`,
one line per row — `time`, `loop #tick`, result, duration, usage, detail — omitting empty
`usage`/`detail`, rendering `—` for a null `durationMs` (reusing `shortSpanPhrase` from
src/text/phrases.ts), and `""` for no rows. Result is the `TickRow.result` string verbatim, so
the pane never reclassifies what history-data.ts resolved.
2. src/ui/tui/tui-frame.ts: add `{ kind: "history" }` to `TuiView`; append `["history",
"History"]` to `tabStrip`'s tab list after Failures, so the existing usage/failures indices and
their tests do not move; give `hintLine` a History branch with the Usage/Failures keys (`Enter
send · ↑↓ history · PgUp/PgDn scroll · Ctrl+T next view · Ctrl+D quit`).
3. src/ui/tui/tui-pane.ts: a `pane.kind === "history"` branch that windows `state.paneCache`
through `entryBodyWindow(state.paneCache ?? "", state.paneScroll, eventBudget, width)` and
returns `emptyNote: "(no ticks yet)"`; enumerate History in the module's header comment.
4. src/ui/tui/tui-keys.ts: change the cycle modulus to `roleIds.length + 5`, add the history
index `roleIds.length + 4` to the `paneCache` ternary (`readTickRows(root,
HISTORY_DEFAULT_TICKS, null)` → `historyPaneText`), and update the cycle comment. The existing
PgUp/PgDn condition (`view >= roleIds.length + 2`) and `stepEntryScroll` already page it.
5. src/ui/tui/tui.tsx: map `view === roleIds.length + 4` to `{ kind: "history" }` in the pane
assembly.
6. docs/how-it-works.md's Operator-notes TUI bullet: name History in the `Ctrl+T` cycle.

**Files touched.**
- `tui-history.ts` (new, in src/ui/tui/)
- src/ui/tui/tui-frame.ts (`TuiView`, `tabStrip`, `hintLine`)
- src/ui/tui/tui-pane.ts (`paneBody`)
- src/ui/tui/tui-keys.ts (cycle modulus, `paneCache`)
- src/ui/tui/tui.tsx (view mapping)
- docs/how-it-works.md

Tests: a new `tui-history.test.ts` under test/ for `historyPaneText` (a seeded `TickRow` renders
every field; a null `durationMs` shows `—`; an empty `usage` is omitted; no rows → `""`); update
test/tui-frame.test.ts's tab-strip and hint assertions for the new History tab; extend
test/tui-keys.test.ts's view-cycle test to reach `roleIds.length + 4` and page it.

**Acceptance criteria.**
- `Ctrl+T` cycles Activity → each loop's Transcript → Backlog → Usage → Failures → History →
Activity, and the tab strip shows `[History]` last.
- The History pane shows the newest `HISTORY_DEFAULT_TICKS` completed ticks from
`readTickRows(root, HISTORY_DEFAULT_TICKS, null)`, one per line: the row's time, `loop #tick`,
result, duration (or `—`), usage, and detail.
- PgUp/PgDn page the pane and clamp at both ends, exactly as Usage/Failures page their Markdown;
a log with no completed ticks shows `(no ticks yet)`.
- `tumwater history`, `history --json`, and the GUI History view are unchanged (their renderers
and `TickRow` are untouched).
- `npm run test` green.


### Inspect a loop's notebook and next tick prompt in the TUI (planned 2026-10-09 by plan; done 2026-10-09 by feature; sibling of "Inspect a loop's notebook and next prompt in the dashboard drawer")

**Goal.** Viewing a loop's transcript in `tumwater tui` gains a notebook view: `Ctrl+N`
switches the viewed loop's pane between its live transcript and a read-only snapshot of its
notebook and next tick's assembled prompt — the same two things the dashboard drawer shows, so
the terminal and the browser diagnose a quiet, stuck, or oddly-behaving loop the same way.

**Context.** `rolePayload` (src/roles/role-view.ts) already collects both: `note` is the loop's
notebook read from `roleNotesPath`, and `nextPrompt` is the next tick's assembled prompt through
the preview seam. The dashboard drawer reaches them through `handleRole` (`GET /api/role`,
src/gui/gui-endpoints.ts). The TUI does not: `paneBody`'s transcript branch
(src/ui/tui/tui-pane.ts) only returns `readTranscript`, `TuiView`'s transcript variant
(src/ui/tui/tui-frame.ts) carries no note flag, and no key in the Ctrl+T cycle's handler
(src/ui/tui/tui-keys.ts) reaches `rolePayload`. `renderRoleMarkdown` (src/roles/role-render.ts)
already renders the Notebook and Next tick prompt fenced blocks for `tumwater role <id>`. This is
an observability gap only — no new collection, scheduling, or state.

**Approach.**
1. src/roles/role-render.ts: extract the Notebook and Next tick prompt blocks (the two
   `fencedOrNone` calls plus the "more waits" note) out of `renderRoleMarkdown` into an exported
   `inspectMarkdownLines(p: RoleViewPayload): string[]`; `renderRoleMarkdown` splices it back at
   the same position, producing the same lines in the same order.
2. src/ui/tui/tui-pane.ts: add `noteCache: string | null` to `TuiPaneState`, and an exported
   `roleInspectMarkdown(root, role): string` that returns
   `inspectMarkdownLines(rolePayload(root, role)).join("\n")`. In `paneBody`'s transcript branch,
   when the pane's new `note` flag is set, window `state.noteCache` through the existing
   `entryBodyWindow(state.paneScroll, eventBudget, width)` (bold lines starting `#`, like the
   usage/failures panes) instead of `readTranscript`, with emptyNote `(nothing to inspect yet)`.
3. src/ui/tui/tui-frame.ts: add `note: boolean` to `TuiView`'s transcript variant. `tabStrip`
   labels that tab `Notebook: <role> (<index>/<count>)` when `note`, else today's `Transcript: …`.
   `hintLine`'s transcript branch gains `["Ctrl+N", view.note ? "transcript" : "notebook"]`
   beside the existing per-loop keys.
4. src/ui/tui/tui-keys.ts: add `let noteMode = false; let noteCache: string | null = null;` and
   both fields to `TuiKeysState`. A Ctrl+N branch (guarded to a transcript view, out of
   budget-edit and role-prompt modes) toggles `noteMode`, computes
   `noteCache = roleInspectMarkdown(root, role)` inside try/catch (`flashError` on a throw, leaving
   the mode off), nulls it when leaving, and resets `paneScroll = 0` each way. The Ctrl+T handler
   resets `noteMode = false; noteCache = null` beside its `paneScroll = 0`. The PgUp/PgDn branch
   pages `noteCache` when `noteMode`, else `paneCache`.
5. src/ui/tui/tui.tsx: build the transcript pane as `{ kind: "transcript", role, index: view,
   count: roleIds.length, note: s.noteMode }`.
6. docs/how-it-works.md's TUI "Operator notes" bullet names `Ctrl+N` beside `Ctrl+R` as the
   transcript/notebook toggle.

**Files touched.**
- src/roles/role-render.ts (`inspectMarkdownLines`, `renderRoleMarkdown`)
- src/ui/tui/tui-pane.ts (`TuiPaneState.noteCache`, `roleInspectMarkdown`, `paneBody`)
- src/ui/tui/tui-frame.ts (`TuiView`, `tabStrip`, `hintLine`)
- src/ui/tui/tui-keys.ts (`noteMode`, `noteCache`, Ctrl+N, Ctrl+T, PgUp/PgDn, `state()`)
- src/ui/tui/tui.tsx (transcript pane)
- docs/how-it-works.md (Operator notes)
- test/tui-frame.test.ts (the transcript variant's new `note` field)
- test/tui-operator-keys.test.ts, test/tui.test.ts (hint-order assertions gain Ctrl+N)

Tests: a case in test/role-view.test.ts for `inspectMarkdownLines` (its two sections and the
"more waits" line, and that `renderRoleMarkdown` still contains them in place), and TUI cases
(test/tui-notebook.test.ts, following the `withTui` pattern of test/tui-role-prompt.test.ts)
that seed a loop notebook via `fs.writeFileSync(roleNotesPath(repo, role), …)` and a queued
prompt for that loop, pin the notebook/none-yet and toggle-back rendering, and page the body
with PgUp/PgDn.

**Acceptance criteria.**
- `Ctrl+N` on a loop's transcript replaces the live transcript with a **Notebook** heading and the
  loop's note, and a **Next tick prompt** heading and that loop's assembled prompt; the tab strip
  reads `Notebook: <role> (i/n)` and the hint line offers `Ctrl+N transcript`. A loop with no
  notebook renders the fenced `_(none yet …)_` placeholder from `inspectMarkdownLines`, not the
  transcript's `(no transcript yet)`.
- `Ctrl+N` again (or `Ctrl+T`, or `Esc`-free cycling away) restores the live transcript, and the
  pane's scroll is back at its head.
- PgUp/PgDn in notebook mode page the assembled text and clamp at both ends, exactly as the
  usage/failures panes page their Markdown.
- A `rolePayload` throw on entering notebook mode leaves the transcript shown and flashes
  `error: <message>`; the TUI does not exit.
- `renderRoleMarkdown(rolePayload(root, id))`'s output is unchanged by the extraction: the
  Notebook and Next tick prompt blocks and the "more waits" line appear in the same positions
  (pinned by the existing test/role-view.test.ts cases and the new `inspectMarkdownLines` case).
- `npm run test` green.

### Mark why a backlog entry is held in `tumwater backlog` (planned 2026-10-09 by plan; done 2026-10-09 by feature)

**Goal.** `tumwater backlog` and its `--json` show the same eligibility hold the loop prompts'
`<backlog-index>` already carries, so an operator can see why a planned feature or open bug is
not being taken — refused, needs review, needs replan, or blocked on a named prerequisite —
instead of inferring it from a fleet that looks idle.

**Context.** `entryHold` (src/backlog/backlog-eligibility.ts) already decides holds from a body's
note lines and a heading's `requires … landed` parenthetical against the still-planned entries,
and `holdMark` (src/backlog/backlog-structure.ts) already renders ` [refused]`,
` [needs review]`, ` [needs replan]`, ` [blocked: requires …]`. Today that mark is the prompt
block's private detail — `renderBacklogIndexBlock` is `holdMark`'s only caller, and the
operator's `backlogPayload`/`renderBacklogMarkdown` carry the entries verbatim with no hold. This
is an observability gap, not a new eligibility rule: nothing about scheduling changes.

**Approach.**
1. Move `holdMark` from src/backlog/backlog-structure.ts into src/backlog/backlog-eligibility.ts,
   exported beside `holdMark`'s `EntryHold`; backlog-structure imports it back unchanged, so the
   prompt index and the CLI share one wording.
2. Add `backlogHolds(root): { plans: EntryHold[]; bugs: EntryHold[] }` to
   src/backlog/backlog-eligibility.ts: read `plannedPlanEntries(root)` once, map each planned
   entry through `entryHold(entry, planned)` and each `openBugEntries(root)` entry through the
   same, so each array is parallel to `backlogPayload`'s `plans`/`bugs`. Questions carry no holds.
3. Widen src/backlog/backlog-render.ts's input to `BacklogView` (`BacklogPayload` plus optional
   `holds: { plans: EntryHold[]; bugs: EntryHold[] }`): `renderSection` appends
   `holdMark(holds?.[i])` to a plan's or bug's `### ` heading, and an absent `holds` array or a
   null hold leaves the heading exactly as today.
4. src/cli/cli-query-commands.ts's `cmdBacklog` thunk returns
   `{ ...backlogPayload(root), holds: backlogHolds(root) }`, so the `--json` document and the
   Markdown consume one collection exactly as they do now.
5. README.md's `tumwater backlog` row names the hold mark beside both the human and `--json`
   forms.

**Files touched.**
- src/backlog/backlog-eligibility.ts (`backlogHolds`, `holdMark`)
- src/backlog/backlog-structure.ts (`holdMark` import)
- src/backlog/backlog-render.ts (`BacklogView`, `renderSection`)
- src/cli/cli-query-commands.ts (`cmdBacklog` thunk)
- README.md (`backlog` row)

Tests: cases in test/backlog-eligibility.test.ts (a refused/needs-review/blocked entry and an
eligible one) and test/backlog-render.test.ts (the rendered headings, the unchanged no-holds
render, and the CLI `--json` holds).

**Acceptance criteria.**
- `tumwater backlog` prints a plan whose heading names a still-planned prerequisite as
  `### <title> [blocked: requires <series> <part>/<of>]`, a refused bug as `### <title>
  [refused]`, and an eligible entry's heading byte-identically to today.
- `tumwater backlog --json` gains `holds.plans` and `holds.bugs`, arrays parallel to
  `plans`/`bugs` (`null` for an eligible entry, the `EntryHold` value otherwise); every existing
  field is unchanged.
- `renderBacklogMarkdown(backlogPayload(root))` (no `holds`) renders today's document unchanged,
  so the existing render test stays green untouched.
- `backlogHolds` marks a **Refused**, **Needs review**, or **Needs replan** body line and a
  blocked heading, and leaves an eligible entry null.
- `npm run test` green.

### Inspect a loop's notebook and next prompt in the dashboard drawer (planned 2026-10-09 by plan; done 2026-10-09 by feature)

**Goal:** the browser dashboard's loop drawer gains a read-only **Notebook** section (what the
loop remembers between fresh sessions) and a collapsible **Next tick prompt** section (exactly
what its next tick will read). The operator can diagnose a quiet, stuck, or oddly-behaving loop
from the page they are already watching, without dropping to the terminal for
`tumwater role <id>`.

**Context.** `rolePayload` (src/roles/role-view.ts) already collects both: `note` is the loop's
notebook (`roleNotesPath`, capped at 4 KB) and `nextPrompt` is the next tick's assembled prompt
through the preview seam; `renderRoleMarkdown` (src/roles/role-render.ts) renders them for the
CLI. Neither reaches the dashboard: there is no `/api/role` route in src/gui/gui-server.ts's
route table, and src/ui/gui/gui-client-drawer.ts shows state, controls, current work, last
result, metrics, recent ticks, live transcript and the unlanded change, but no notebook and no
next prompt. This is an observability gap only — no new collection, scheduling, or state.

**Approach.**
1. Add `handleRole(q: URLSearchParams, res: http.ServerResponse, root: string): void` to
   src/gui/gui-endpoints.ts, beside `handleTranscript`: read `role` from the pre-parsed query,
   validate with `rejectBadRole(root, res, role)` (missing → `role required (valid ids: …)`,
   unknown → `unknown role …`, same shared wording and typo hint), then
   `sendJson(res, 200, rolePayload(root, role as string))`. Return the payload as fields; the
   drawer renders `note`/`nextPrompt` itself, and `renderRoleMarkdown` stays the CLI's renderer.
2. Register `"GET /api/role": (_req, res, target) => handleRole(target.searchParams, res, root)`
   in src/gui/gui-server.ts's route table (beside `GET /api/tick`).
3. In src/ui/gui/gui-client-drawer.ts add a cached view (`drawerRole`, keyed by role, with
   `loading`/`ok`/`error` states) fetched from `/api/role?role=` once when a loop opens and
   cleared by `closeDrawer`; `openLoop` and switching roles refetch. Add a `drawerRoleSection()`
   helper that renders `<h3>Notebook</h3>` with the note in a `<pre>` (escaped through `esc`), a
   muted `No notebook yet.` placeholder when `note` is null, and a `<details><summary>Next tick
   prompt</summary><pre>…</pre></details>` whose body is a muted `Nothing to run (empty inbox).`
   when `nextPrompt` is null. Paint it into its own `<div id='drawerrole'>` panel (added to
   `showDrawer`'s body and the `lastPaint`-clear lists), not the `paintPanel("drawermeta", …)`
   chain: the 1 s poll rewrites `drawermeta` whenever its countdown or tick-age text changes,
   and an innerHTML rewrite would collapse an opened `<details>`. `renderLoopDrawer` paints
   `drawerrole` in both the live and missing-role branches, so it renders for a role the fleet
   no longer has too. The panel's string is stable while its payload is unchanged, so
   `paintPanel` skips it and the disclosure stays open across polls.
4. docs/how-it-works.md "Operator notes": extend the dashboard paragraph's "Clicking a loop
   opens its details" clause to name the notebook and next-tick prompt.

**Files touched.**
- src/gui/gui-endpoints.ts (`handleRole`)
- src/gui/gui-server.ts (route table)
- src/ui/gui/gui-client-drawer.ts (fetch, cache, `drawerRoleSection`, render)
- docs/how-it-works.md (Operator notes clause)
- test/gui-endpoints.test.ts, test/gui-client-drawer.test.ts

Tests: in test/gui-endpoints.test.ts add a `handleRole` case seeding a role notebook and
asserting the 200 body matches `rolePayload`'s `note`/`nextPrompt` plus the two `rejectBadRole`
400s (missing role, unknown role). In test/gui-client-drawer.test.ts add a case opening a loop,
serving `/api/role`, and asserting the drawer renders the notebook text, then switching roles
and asserting the refetch shows the second loop's note (not the first's).

**Acceptance criteria.**
- `GET /api/role?role=<known id>` answers 200 with `rolePayload(root, id)` (`note` and
  `nextPrompt` included); a missing or unknown id answers the same 400 JSON `rejectBadRole` gives
  `/api/transcript`, and `rolePayload` is never called for it.
- Opening a loop whose notebook file is non-empty renders a **Notebook** section containing that
  text; a loop with no notebook (or an empty one) shows `No notebook yet.`
- The **Next tick prompt** section renders `nextPrompt` verbatim; a director with an empty inbox
  shows the nothing-to-run note instead.
- Switching the open drawer from one loop to another shows the new loop's notebook and prompt,
  not the previous loop's cached text.
- A status poll that rewrites `drawermeta` (its tick-age text changes) does not repaint the
  `drawerrole` panel, so an opened **Next tick prompt** disclosure is not collapsed.
- `npm run test` green.


### Notify the operator when a loop posts a question (planned 2026-10-09 by plan; done 2026-10-09 by feature)

Design: this is the missing push half of the questions outbox. Loops ask the operator to decide
by merging an entry into QUESTIONS.md `## Open`; `tumwater questions`, the TUI/GUI backlog and the
fleet-alerts panel are all pull surfaces, and the `notify` hook — the one push channel — does not
fire for that event. The hook's own contract (src/events/notify.ts, config-schema.ts) already
covers "the states where only a human can act"; a posted question is exactly that state, so this
is an allowlist gap, not a new mechanism.

The event already exists and is already in scope for the notifier: `logNewQuestions`
(src/landing/landing-questions.ts) logs one `question_posted` per new Open heading through
`logEventBestEffort`, which calls `logEvent` and so reaches `newNotifier`'s `subscribeEvents`
listener in the orchestrator process.

**Approach.**
1. Append `"question_posted"` to `NOTIFY_EVENT_TYPES` in src/events/notify.ts.
2. Update that module's doc: "All seven allowlisted types" becomes eight, and its source list
   gains `landing-questions.ts` (the landing pipeline beside `landing-slot.ts`).
3. Update src/config/config-schema.ts's `notify` field doc and README.md's `notify` parenthetical
   to name a posted question among the paged events.

**Files touched.**
- src/events/notify.ts (allowlist entry, module doc)
- src/config/config-schema.ts (`notify` field doc)
- README.md (`notify` parenthetical)
- test/notify.test.ts

Tests: update the pinned literal array in `NOTIFY_EVENT_TYPES and NOTIFY_MIN_GAP_MS stay pinned
to the planned allowlist and gap`; add a spawn case mirroring `an allowlisted event spawns the
notify command once with the three env vars set` with a `question_posted` event (`{ loop: "feature",
question: "…" }`), asserting `TUMWATER_EVENT_TYPE=question_posted`, the posting role, and
`TUMWATER_EVENT_MESSAGE` equal to `formatEvent(event)`.

**Acceptance criteria.**
- A `question_posted` event logged in-process spawns the notify command once, with
  `TUMWATER_EVENT_TYPE=question_posted`, `TUMWATER_EVENT_LOOP` the posting role, and
  `TUMWATER_EVENT_MESSAGE` the rendered `question posted: <heading>` line.
- `NOTIFY_EVENT_TYPES` contains `question_posted`, and the pinned test asserts the updated
  literal array including it.
- A non-allowlisted event still spawns nothing (the existing negative test is unchanged and green).
- The `notify` docs in src/events/notify.ts, src/config/config-schema.ts and README.md name a
  posted question.
- `npm run test` green.

### Agent backends, part 3c3/7: backend-aware resumability across the loop (planned 2026-10-09 by plan; split 2026-10-09 by plan from part 3c/7; requires part 3c1/7 landed; done 2026-10-09 by feature)

Design: plans/agent-backends.md ("Sessions"). The conflict hand-back note on a handoff already
landed in loop-tick.ts (`if (handoff && s.conflictHandback?.applied)`), so this part is only the
resumability guards.

**Goal:** every resume and same-session guard asks the run's own backend whether its session is
resumable, so a claude author or gate run resumes through its ledger id instead of being read
as having no session (which would reset the worktree and lose the interrupted run's edits).

**Approach.**
1. **Session-file check moved.** `hasResumableSession` now lives in
   `src/agent/session-ledger.ts` (its filesystem check is backend-neutral: a `.jsonl` in the
   dir other than `SESSION_LEDGER_FILE`, which is no longer exported), and `src/pi/pi.ts`
   re-exports it so every existing importer and test is unchanged. Moving it avoids an import
   cycle: session-ledger.ts imports only files.ts, while pi.ts reaches run-agent.ts.
2. **Hook + dispatcher.** `src/agent/agent-backend.ts` adds optional `resumable?(dir: string,
   opts: { kind: string; agent: string; cwd?: string }): boolean` to `AgentBackend`, and exports
   `agentSessionResumable(dir, opts)` dispatching to `agentBackend(opts.agent)?.resumable`, or
   falling back to `hasResumableSession(dir)` when the backend is unregistered or has no hook.
3. **pi implementation.** `src/pi/pi-backend.ts`: `resumable(dir, opts)` =
   `sessionResumable(dir, opts, hasResumableSession(dir))`.
4. **claude implementation.** `claude-backend.ts` under src/agent/claude/: a shared
   `claudeResumableRecord` (newest record of the kind at the requested cwd whose transcript
   exists) backs both `resumable(dir, opts)` and the invocation's `--resume` choice, so the
   guard and the run cannot drift.
5. **Replace the same-session guards** with `agentSessionResumable`: `planTickStart`
   (src/tick/tick-resume.ts, passing `{ kind: "author", agent }` and no cwd, since it runs
   before the lease — the adapter's own cwd match in `invocation` stays the runtime second
   line), `requestFollowUp`'s guard (src/loop/loop-pi.ts), the review-follow-up guard
   (src/review/review-followup.ts), and the reviewer's two timeout-progressing resume guards
   (src/review/review.ts) — the original three-guard list missed review.ts, whose guards would
   otherwise read a claude gate run as having no session.
6. **Tests.** `test/tick-resume.test.ts` (a claude author resumes when its transcript exists,
   resumes its id past a newer gate line, and hands off when the newest line names another
   agent or its own transcript is gone — part 3d widened the latter from a worktree reset),
   `test/review-followup.test.ts`
   (a claude gate session resumes without a pi session file), and the adapter's `resumable`
   predicate in `test/claude-run.test.ts`. The entry named `test/loop-interrupted.test.ts`; the
   decision it targets is pinned directly in tick-resume.test.ts because planTickStart owns it
   and `loop-tick.ts` keeps the slot from `plan.resuming || plan.handoff` unchanged.

**Files touched:** `src/agent/agent-backend.ts`, `src/agent/session-ledger.ts`,
`src/pi/pi-backend.ts`, `src/pi/pi.ts`, `claude-backend.ts` under src/agent/claude/,
`src/tick/tick-resume.ts`, `src/loop/loop-pi.ts`, `src/review/review-followup.ts`,
`src/review/review.ts`, `test/tick-resume.test.ts`, `test/review-followup.test.ts`,
`test/claude-run.test.ts`.

**Acceptance criteria:**
- With `config.agent = "claude"` and a transcript present for the newest author ledger line,
  `planTickStart` sets `resuming: true` and the tick's slot is kept (`keep`); with the transcript
  absent it does not resume but hands off over the kept worktree (part 3d superseded the reset).
  A newest line naming another agent still hands off.
- A claude `requestFollowUp` and a claude review follow-up pass `--resume <recorded id>`; a pi
  session dir still uses pi's `--continue` exactly as today.
- A ledger line whose cwd differs from the requested cwd is not resumable.
- The project's check passes.

### Agent backends, part 3d/7: `resumeMissing` resumes as a `handoff` (planned 2026-10-09 by plan; split from part 3/7; requires part 3c3/7 landed; done 2026-10-09 by feature)

Design: plans/agent-backends.md ("Sessions").

**Approach.**
1. When a `--resume` run ends with `PiRunResult.resumeMissing` (part 3a), its error turn carries
   no assistant content, so `resolveTickVerdict` (src/tick/tick-verdict.ts) keeps the worktree and
   arms `resumePending` exactly as for any failed dirty run.
2. `planTickStart` (src/tick/tick-resume.ts) then sees the newest author ledger line as not
   resumable (`agentSessionResumable`, part 3c3/7 — its transcript is gone) and hands off
   instead of resetting: a FRESH session over the kept worktree whose prompt is
   `buildHandoffPrompt` (src/prompt/prompt-followup.ts) over the assembled tick prompt, and the
   `resume` event reports the `handoff` cause. The pre-3d rule only handed off for a newest
   line of another kind or agent; it now hands off for any newest line the run's own backend
   cannot resume, which is exactly the `resumeMissing` case.
3. The retry is deliberately NOT done inside `runWithTransientRetry` (src/loop/loop-pi.ts):
   every resume that can report `resumeMissing` runs a resume bridge or a follow-up prompt, not
   the tick prompt `buildHandoffPrompt` needs, so a fresh session there would get no task. The
   next tick is the first point the assembled tick prompt (including a reclaimed per-role
   request) is available, and the pinned slot keeps the interrupted edits until then.

**Files touched.**
- src/tick/tick-resume.ts
- test/tick-resume.test.ts

**Acceptance criteria.**
- A fake-claude run whose `--resume` id has no transcript yields `resumeMissing`; driven
  through `resolveTickVerdict` against a dirty worktree, the failed turn arms `resumePending`,
  and the next `planTickStart` hands off — a fresh session over the kept worktree with the
  assembled tick prompt plus the handoff bridge — rather than resetting.
- A newest author line whose session is resumable still resumes; a dir with no ledger line
  still falls back to a fresh tick.
- `npm run test` green.

### Agent backends, part 3c2/7: the claude native log and translator warnings (planned 2026-10-09 by plan; split 2026-10-09 by plan from part 3c/7; requires part 3c1/7 landed; done 2026-10-09 by feature)

Design: plans/agent-backends.md ("Canonical event stream": the native stream is kept for
debugging only); part 3a/7's `ClaudeStreamTranslator.warnings()` already collects the unmapped
native types and a result-less run's `cost_unknown`.

**Goal:** a claude run's raw stdout is kept beside the canonical log for debugging, and the
native shapes the translator could not map are visible in the event feed.

**Approach.**
1. **Path.** `src/paths.ts`: add `nativeLogPath(root, role, agent)` =
   `.tumwater/log/<role>.<agent>.native.jsonl`, beside `piLogPath`, documented as debug-only.
   Add `nativeLogFile: string` to `PiRunOptions` (src/agent/run-agent.ts) and pass it at the
   three `rawLogFile` construction sites: `loopPiOpts` in src/loop/loop-pi.ts, src/review/review.ts,
   src/review/review-followup.ts (each already computes `piLogPath(root, role)`, so the native
   path names the same agent the run actually uses).
2. **Write.** In `run-agent.ts`, open the native log like the raw log (`ensureParentDir` +
   `rotateIfLarge`); in `feedCanonical` write each complete native `line` to it before
   `translator.translate`. A broken native log is non-fatal exactly as `rawLogBroken` is.
3. **Warnings.** Add optional `warnings?(): string[]` to `StreamTranslator`
   (src/agent/agent-backend.ts); `ClaudeStreamTranslator` already has it. Add
   `onAgentWarning?: (warning: string) => void` to `PiRunOptions`; after the run, `run-agent.ts`
   forwards each `translator.warnings?.() ?? []` entry once. Wire it in `loopPiOpts` as
   `(w) => this.host.warn(`agent_unknown_event: ${w}`)`.
4. **Tests.** Extended `claude-run.test.ts` (native-log content, empty-native and result-less
   runs, rotation, and the warning callbacks) and added a loop-pi test that a claude run lands
   its native log at the role.agent path and surfaces `agent_unknown_event: …` through the host.

**Files touched:** `src/paths.ts`, `src/agent/run-agent.ts`, `src/agent/agent-backend.ts`,
`src/loop/loop-pi.ts`, `src/review/review.ts`, `src/review/review-followup.ts`,
`test/claude-run.test.ts`, `test/loop-pi.test.ts`, `test/pi.test.ts` (its stalled-stream raw-log
flush test now keys the injected stream by path, since a run opens two logs),
`src/agent/claude/claude-stream.ts` (warning comment), plus the test fixtures that construct
`PiRunOptions`.

**Acceptance criteria:**
- A fake-claude run writes its raw native lines to `.tumwater/log/<role>.claude.native.jsonl`
  and canonical lines to the raw log; a run with no native output writes none.
- The native file rotates under `logMaxBytes` the way the raw log does.
- A run with an unmapped native type and a result-less run each produce exactly one
  `agent_unknown_event` warning naming the type / `cost_unknown`; a fully-mapped run produces
  none.
- The project's check passes.

### Agent backends, part 3c1/7: the claude backend adapter and PATH fake (planned 2026-10-09 by plan; split 2026-10-09 by plan from part 3c/7, which feature judged too large for one run; requires parts 3a/7 and 3b/7 landed; done 2026-10-09 by feature)

Design: plans/agent-backends.md ("The seam", "Sessions", "Testing").

Registers claude as an adapter and proves a run end to end on a fake. Still not selectable from
tumwater.json (part 4/7); tests drive it through `runAgent` with `config.agent = "claude"`.
Parts 3c2/7 (native log and translator warnings) and 3c3/7 (backend-aware resumability across
the loop) build on this and require it landed.

**Goal:** `runAgent` runs claude on a fake and folds its stream exactly as it folds pi's, with a
per-run session ledger the loop's later resume paths can query by ledger id.

**Approach.**
1. **Seam additions.** `src/agent/agent-backend.ts`: add `kind: PiRunKind` to `AgentRunSpec`
   (the adapter needs it for the ledger and the translator); add `sessionId?: string` to
   `AgentInvocation` — the backend session id this run used (minted for a fresh claude run, the
   resumed record's id for a continue), absent for pi, which mints no id ahead of the run.
   `src/agent/run-agent.ts` records it: `recordSession(opts.sessionDir, { ..., id:
   invocation.sessionId ?? opts.sessionName, ... })`.
2. **Binary resolution.** `src/pi/pi-bin.ts`: extract `resolveBinFrom(binEnv, defaultBin,
   configured?)` from `resolveAgentBin` (pi keeps env → `config.agentBin` → `"pi"`); give
   `agentBinSourceLabel(source, binEnv = "TUMWATER_PI_BIN")` the env name so a spawn error names
   `TUMWATER_CLAUDE_BIN`; `run-agent.ts`'s `spawnErrorMessage` passes `backend.binEnv`.
3. **Adapter.** New `claude-backend.ts` in the claude adapter directory (src/agent/claude/) exporting `claudeBackend: AgentBackend`:
   `id: "claude"`, `label: "Claude Code"`, `defaultBin: "claude"`, `binEnv:
   "TUMWATER_CLAUDE_BIN"`, `resolveBin` via `resolveBinFrom`, and:
   - `invocation(run)`: pick the session id (step 4), then `claudeArgs({ cwd: run.cwd, model:
     run.config.model, thinking: run.config.thinking, sessionId | resumeSessionId, prompt:
     run.prompt })`; layer the environment as pi's adapter does —
     `runMarkerEnv(withoutLaunchServicesCheckIn(process.env), run.runMarker)` then
     `claudeEnv(base, { quietTimeoutSeconds: run.config.quietTimeoutSeconds })` (both modules
     landed in 3b/7). Throw a clear error when `run.config.model` is undefined, since part 4/7
     resolves the tier defaults. Return `{ args, stdin, env, sessionId }`.
   - `translator()`: `claudeTranslator()` from 3a/7.
   - `classifyExit(info)`: `{}` when `info.killed`; otherwise `{ configError: true }` when
     `info.code !== 0` and stderr matches
     `/Not logged in|issue with the selected model|does not support this model/i`, else `{}`.
     (The event path in claude-stream.ts classifies the stream itself; this is the stderr half.)
4. **Session decision.** In `invocation`, fresh (`!run.continueSession`): `randomUUID()` and pass
   it as `sessionId`. Continue: `resumableSession(run.sessionDir, { kind: run.kind, agent:
   "claude", cwd: run.cwd })`; resume with `resumeSessionId: record.id` only when the record
   exists and its transcript file exists, else mint a fresh id. Add
   `claudeTranscriptPath(cwd, id)` = `path.join(os.homedir(), ".claude", "projects",
   claudeProjectSlug(cwd), `${id}.jsonl`)` with `claudeProjectSlug(cwd) =
   cwd.replace(/[^A-Za-z0-9]/g, "-")`, exported so the fake and tests create the same file.
5. **Registration.** `run-agent.ts`: `registerAgentBackend(claudeBackend)` beside `piBackend`.
6. **Fake.** New `fake-claude.ts` under test/fakes/ on fake-pi.ts's conventions: a PATH shim named
   `claude` replaying canned stream-json, logging argv and stdin per run, and creating the
   transcript at `claudeTranscriptPath` under a temp HOME. `test/test-runner.ts`'s `suiteEnv`
   additionally deletes `TUMWATER_CLAUDE_BIN`, `CLAUDECODE`, and every `CLAUDE_CODE_*`.
7. **Tests.** New `claude-run.test.ts` under test/ driving `runAgent`.

**Files touched:** new `claude-backend.ts` under src/agent/claude/, `src/agent/agent-backend.ts`,
`src/agent/run-agent.ts`, `src/pi/pi-bin.ts`, new `fake-claude.ts` under test/fakes/,
new `claude-run.test.ts` under test/, `test/test-runner.ts`.

**Acceptance criteria:**
- `runAgent` on fake-claude with `config.agent = "claude"` and a set `config.model` returns the
  folded `PiRunResult` (cost from the final `result`), and the raw log holds canonical lines the
  existing readers render.
- A fresh run's argv carries `--session-id <uuid>`; the session ledger gains one line with that
  id, `agent: "claude"`, the run's kind and cwd; the fake created the transcript at the matching
  `claudeTranscriptPath`.
- A `continueSession` run from the same cwd and kind passes `--resume <recorded id>`; a ledger
  record whose cwd differs, or whose transcript file is absent, gets a fresh `--session-id`.
- The spawned env strips `CLAUDECODE` and `CLAUDE_CODE_SESSION_ID` even when the suite's parent
  carries them; stdin carries the prompt.
- `classifyExit` maps a nonzero exit with "Not logged in" stderr to `configError` and leaves a
  killed run unclassified.
- The project's check passes.

### A review retry picks up the timed-out reviewer's session, part 3/3: resumed-review event and failure digest (planned 2026-10-09 by operator; split from "A review retry picks up the timed-out reviewer's session instead of reviewing from scratch"; requires part 2/3 landed; done 2026-10-09 by feature)

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

### A review retry picks up the timed-out reviewer's session, part 2/3: record and resume a progressing-timeout review session (planned 2026-10-09 by operator; split from "A review retry picks up the timed-out reviewer's session instead of reviewing from scratch"; requires part 1/3 landed; done 2026-10-09 by feature)

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

### Retract a config value: `tumwater config unset <key>` (planned 2026-10-09 by plan; done 2026-10-09 by feature)

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
  `kind: "role"` delete the named field of the role entry. Drop the containing top-level key
  when it empties (an emptied map, an emptied `model` map) so the file never keeps an empty
  object; the code also drops a `roles.<id>` entry when its last field goes, but `loadConfig`
  always seeds `enabled`/`minTickIntervalSeconds`, so through the CLI that branch is
  unreachable and an emptied role entry keeps its seeded defaults instead. Presence is judged
  against the raw FILE (a fresh `parseJsonConfig` inside the lock), not the merged config: a
  key or field the file never set but the defaults fill in — a top-level `quietHours`/`maxConcurrent`,
  a seeded `roles.<id>.minTickIntervalSeconds` — is a no-op success (see the acceptance
  criterion: the write is skipped and the bytes are unchanged). Run the merged candidate
  through the existing
  `writeConfigMutation` unchanged, so the
  lock, `validateConfig`, and `writeJsonAtomic` still own truth — a candidate validation rejects
  leaves the file byte-identical. Capture `oldValue` from the raw file's own value (the value
  removed, or `undefined` when the file never held it). Legacy `provider`/`fallbackModel`
  top-level keys
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
`test/config-commands.test.ts`,
`test/cli-operators-fleet.test.ts` (the CLI arity gate and help stanza assertions).

**Acceptance criteria:**

- `tumwater config unset roles.qa.model` on a config that holds it removes the field and leaves
  the entry's other fields; `tumwater config get roles.qa.model` then prints `null` (loadConfig
  seeds a role entry's defaults such as `enabled`/`minTickIntervalSeconds`, so the
  resolved entry keeps them rather than disappearing).
- `tumwater config unset maxDailyCostUsdPerRole.feature` removes that entry and preserves the
  map's other roles; `tumwater config unset model.strong` removes that tier (a single-selector
  string `model` is left untouched when the named tier is not one of its resolved entries);
  `tumwater config unset quietHours` removes the top-level key and `config get quietHours` then
  reads the default.
- Unsetting an absent entry (e.g. `maxDailyCostUsdPerRole.clean` with no entry), a
  default-carrying top-level key the file never set (`maxConcurrent`, `quietHours`), or a
  default-seeded role field the file never set (`roles.qa.minTickIntervalSeconds`) exits 0 as a
  no-op and changes nothing: presence is judged against the raw file, so the mutation returns
  the loaded config unchanged, `writeConfigMutation` skips the atomic write entirely, and the
  file keeps its exact bytes rather than re-serializing the merged config with defaults
  expanded; the confirmation names the key with no `(was …)` value.
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

### A review retry picks up the timed-out reviewer's session, part 1/3: per-review session directories (planned 2026-10-09 by operator; split from "A review retry picks up the timed-out reviewer's session instead of reviewing from scratch", which feature judged too large for one run; done 2026-10-09 by feature)

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

- New-project bootstrap, part 2/2: while bootstrapping, only plan, feature, director and bugfix-with-open-bugs tick (planned 2026-10-08, done 2026-10-08; commit d98c6e74)
- New-project bootstrap, part 1/2: `tumwater init` recognizes an empty project and opts it into bootstrap (planned 2026-10-08, done 2026-10-08; commit 7c5c12e8)
- Work ratio, part 3/4: the plan loop's "enough waiting" target counts only entries feature could take now (planned 2026-10-08, done 2026-10-08; commit 4f390088)
- Work ratio, part 4/4: report commits by role and show work vs maintenance commits on the "Landed today" tile and `tumwater report` (planned 2026-10-08, done 2026-10-08; commit 00b86b94)
- Parallel work instances, part 5c/7: the plan charter's target scales with `feature.instances` (planned 2026-10-08, done 2026-10-08; commit 84093966)
- Parallel work instances, part 5b/7: instance runners spawn at startup and on live reload, gated by claims (planned 2026-10-08, done 2026-10-08; commit f2f6c687)
- Parallel work instances, part 5a/7: the validated `roles.<id>.instances` config field and `loopIds` enumeration (planned 2026-10-08, done 2026-10-08; commit 7378fd27)
- Organize the test suite, part 6/6: remaining fixtures move to `test/fixtures/`, leaving the root clean (planned 2026-10-07, done 2026-10-08; commit a3da2cbe)
- Organize the test suite, part 5/6: log, loop, orchestrator and status fixtures plus `pi-events` and `victim-fixture` move to `test/fixtures/` (planned 2026-10-07, done 2026-10-08; commit f2effe3c)
- Organize the test suite, part 4/6: `repo-fixtures.ts` moves to `test/fixtures/` (planned 2026-10-07, done 2026-10-08; commit 53a7df79)

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
