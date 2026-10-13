# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.


## Planned

### Operator backlog writes land on main, part 2/2: cancelling, editing, and answering commit too (planned 2026-10-12 by plan; requires part 1/2 landed. It reuses part 1/2's `commitOperatorBacklogEdit` from part 1/2's new `backlog-commit.ts` module. The other operator writers of the primary checkout's backlog files leave the same uncommitted edit part 1/2 describes:
- `tumwater plan|bug --cancel <n>` / `--edit <n>` (`cancelAndAnnounce`/`editAndAnnounce` in `src/backlog/backlog-write.ts`);
- `tumwater questions answer` (`answerQuestion`/`answerQuestionFromText`, called from `src/cli/cli-query-commands.ts`);
- the dashboard's drawer cancel, edit, and question answer (`tryCancelEntry`/`tryEditEntry`/`tryAnswerQuestion` call sites in `src/gui/gui-endpoint-commands.ts`);
- the TUI backlog pane's Ctrl+X, Ctrl+E, and Ctrl+A (the same three `try*` call sites in `createTuiKeys`, `src/ui/tui/tui-keys.ts`).
A cancelled entry still reads as eligible on main, and an answered question stays open in every loop's worktree)

**Refused 2026-10-12 by feature: prerequisite part 1/2 has not landed (no `src/backlog/backlog-commit.ts` / `commitOperatorBacklogEdit` exists); re-open once it does**

**Goal.** Each of those writes commits its one file on main, exactly as part 1/2's filings do.

**Approach.** After each successful write, call `commitOperatorBacklogEdit(root, file, subject)`:
- **Subjects.** All built with `stampedSubject("operator", …)`: `Cancel <kind>: <title>`, `Edit <kind>: <title>` (the new title), and `Answer question: <title>`.
- **Where to await.** The CLI announce functions and the dashboard handlers are async and await it. The TUI key branches call it fire-and-forget (`void …`), as part 1/2's Ctrl+N does.
- **Failures.** A refused or no-op outcome (stale position, title mismatch, `UNCLOSED_FENCE_MESSAGE`) writes nothing and commits nothing.
- **Unchanged.** No change to the sync `try*`/`cancel*`/`edit*`/`answerQuestion*` writers, or to any printed output or JSON payload.

**Files.** `src/backlog/backlog-write.ts`, `src/cli/cli-query-commands.ts`, `src/gui/gui-endpoint-commands.ts`, `src/ui/tui/tui-keys.ts`, the `backlog-commit.test.ts` part 1/2 adds, README.md (the same "Steer the project" and "Answer open questions" rows), docs/invariants.md (widen part 1/2's INV entry to name cancel, edit, and answer).

**Acceptance criteria.**
- In a repo on main, `tumwater bug --cancel 1`, `tumwater plan --edit 1 "z"`, and `tumwater questions answer 1 "yes"` each leave `git status --porcelain` empty, with the matching `tumwater(operator): …` subject as HEAD's subject.
- A `--cancel` naming a missing position fails as today and adds no commit (HEAD unchanged).
- The dashboard's cancel, edit, and answer routes each leave the checkout clean in a repo on main.
- Existing tests in test/backlog-write.test.ts, test/question-commands.test.ts, and test/tui-keys.test.ts pass unchanged.

## Done

### Maintenance loops stop deferring on a backlog made only of held entries (planned 2026-10-12 by plan; independent of every other entry; done 2026-10-12)

**Goal.** A maintenance loop should defer as "backlog open" only while feature or bugfix has
something it can actually take.
- `src/orchestrator/orchestrator.ts` computes
  `workBacklogOpen = plannedPlans(root).length > 0 || openBugsNow`. That counts every entry,
  including refused, needs-review, needs-replan and prerequisite-blocked ones.
- On a backlog where every entry is held (as now, apart from one waiting plan), each idle
  deferrable role (`DEFERRABLE_ROLES`) gets `"backlog"` from `deferTickReason`
  (`src/scheduling/scheduling.ts`) on every scheduled or main-moved wake. It then re-checks
  only at the `DEFER_MAX_MS` cap. Meanwhile nothing feature or bugfix lands can lift the
  hold, because no runner can take a held entry.
- `pollRunnerReasons` (`src/orchestrator/orchestrator-scheduling.ts`) also skips the
  `workLandedSince.since(...)` query whenever `workBacklogOpen` is true. A landing from a
  human or the director therefore never ends the deferral either.

**Approach.** The change is one predicate in `src/orchestrator/orchestrator.ts`. It touches no
scheduling union or ctx field.
- Import `eligibleEntries` from `../backlog/backlog-eligibility.js`. It already serves
  `claims.ts` and `orchestrator-scheduling.ts`, and reads through the same stat-cached
  readers.
- Replace the predicate with
  `eligibleEntries(root, "feature").length > 0 || eligibleEntries(root, "bugfix").length > 0`.
- Keep `openBugsNow` (`openBugs(root).length > 0`) exactly as it is. It decides bugfix's
  search mode, and whether a bugfix whose open bugs are all held should search is a
  different question this plan does not answer.
- If `plannedPlans` is no longer used in this file, drop it from the
  `../backlog/backlog.js` import. `status-payload.ts` still uses it.
- Update the comment above the predicate ("while PLANS.md `## Planned` or BUGS.md `## Open`
  on main is non-empty") to say "holds an entry feature or bugfix may take (eligibleEntries)".
- Reword `docs/how-it-works.md`'s maintenance-deferral bullet ("stays deferred while PLANS.md
  or BUGS.md has open work") the same way, e.g. "has work a feature or bugfix runner can take
  (refused, needs-review/replan and blocked entries do not count)".
- Extend the file-header rule list in `test/orchestrator-defer.test.ts` with one line for the
  new rule.

**Files touched.** `src/orchestrator/orchestrator.ts`, `docs/how-it-works.md`,
`test/orchestrator-defer.test.ts`.

**Acceptance criteria.**
- New test in `test/orchestrator-defer.test.ts`: "once: a backlog of only held entries does
  not defer a maintenance role — it defers on the work-landed verdict instead".
  - Seed PLANS.md with one Planned entry whose body carries
    `**Refused 2026-10-12 by feature: test**`.
  - Seed `idleDueState(repo)` for `clean`.
  - Run `onceRound`. `clean` settles as `"deferred"` with `skipReason` `"deferred-no-work"`,
    not `"deferred-backlog"`. Nothing landed since its `lastMainHead`, so the work-landed
    clause now decides.
  - `"deferred-no-work"` is the existing `SkipReason` (`src/loop/loop-state.ts`) for
    `noteSkip`'s `"no-work"` clause.
- The existing test "once: a due maintenance role with an open backlog settles as deferred,
  runs no tick, and logs the episode" still passes unchanged, since its `openBacklog` entry
  is eligible.
- The existing bugfix search-mode test passes unchanged.
- The project's check (`npm run test`) passes.

### A feature runner with no plan to take stands down instead of ticking, and settles its `run --once` round (planned 2026-10-12 by plan; independent of every other entry; done 2026-10-12)

**Goal.** Stop running model ticks that can only end with `TUMWATER_NOTHING_TO_DO`, and fix a
`run --once` round that never exits.

- **Primary runner.** The feature charter (`src/roles/role-catalog.ts`) says "If PLANS.md is
  empty or everything is done, there is nothing to do". Feature skips blocked, refused,
  needs-review and needs-replan entries. Even so, `pollRunnerReasons`
  (`src/orchestrator/orchestrator-scheduling.ts`) admits a due feature runner whenever its
  clock or a main move makes it due, even when `eligibleEntries(root, "feature")` is empty.
  - In a multi-runner group, the claim block's comment says "the primary runs unassigned as
    today".
  - A single-runner fleet has no claim group at all.
  - Each such tick costs a full model run that reads the backlog and stops.
- **Extra instance under `run --once`.** An extra instance with no free entry is skipped via
  `noteSkip(root, runner, "no-free-entry")` and `continue`, but nothing settles its once
  round:
  - `OnceRound.settle` (`src/scheduling/once-round.ts`) is called only for a pause and a
    deferral.
  - `settleSkipped` runs only when `isEligible` says not due.
  - In once mode `isEligible` returns due for every runner with `backoffSeconds === 0`.

  So `tumwater run --once` with `roles.feature.instances` above the number of eligible
  plans never reaches `OnceRound.exitReady`. This was found by reading the code and has not
  been reproduced. The second acceptance test below reproduces it.

**Approach.** Everything lives in `pollRunnerReasons`. No new `SkipReason`, `DeferReason` or
ctx field is added, so this does not touch the unions the plans-full deferral above extends.

- **Stand-down check.** Insert it just before the claim block (`const claimGroup =
  claimGroups.get(...)`). A runner stands down when all of these hold:
  - `baseRoleOf(runner.role) === "feature"`. Bugfix is excluded: with no open bug it
    searches for bugs.
  - `reason === "scheduled" || reason === "main moved"`. This matches the deferral block's
    gate, so `startup`, `inbox` and `resume` ticks still run.
  - No fresh operator wake. Use the same `s.wokenAt !== undefined && s.wokenAt >
    (s.lastTickEndedAt ?? 0)` test `deferTickReason` uses: `tumwater wake feature` always
    gets its tick.
  - `runner.state.claim === undefined && !hasOutstandingWork(runner.state)`. A revision,
    retry or claimed entry finishes.
  - The poll's feature eligible list is empty. Read it as
    `claimGroups.get("feature")?.eligible`, falling back to one `eligibleEntries(root,
    "feature")` call that is memoized in a local variable for the rest of the poll. A
    single-runner fleet then reads PLANS.md at most once per poll, and only when a feature
    runner reaches this check.
- **What standing down does.** It does what the extra-instance branch does:
  - `noteSkip(root, runner, "no-free-entry")`, so `loopPhase` (`src/ui/status-model.ts`)
    already renders `idle: no unclaimed plans`;
  - `runner.state.heldElsewhere = undefined`;
  - `if (once.active) once.settle(runner.role, "no free entry")`;
  - `continue`.

  `nextRunAt` and `backoffSeconds` stay untouched. The runner re-checks every poll and ticks
  on the first poll after a plan becomes eligible (a landing moves main, which makes it due
  as "main moved").
- **Once-round fix.** The existing extra-instance branch (`instanceIndex(runner.role) >= 2`,
  `noteSkip(root, runner, "no-free-entry")`) also calls
  `if (once.active) once.settle(runner.role, "no free entry")` before its `continue`. That
  covers `bugfix-2` and other bugfix extras too.
- **Comments.** Update the claim block's "the primary runs unassigned as today" comment to say
  the primary runs unassigned only while some eligible entry exists (all of them held by
  siblings), and add a comment to the new check pointing at the feature charter's
  nothing-to-do rule.

**Files.** `src/orchestrator/orchestrator-scheduling.ts`,
`test/orchestrator-scheduling.test.ts`, `docs/how-it-works.md` (the "Parallel work instances"
bullet: after "An extra instance with no unclaimed eligible entry is skipped without climbing
its backoff", add that a feature runner, primary included, skips its scheduled and main-moved
ticks while no plan is eligible at all, so an operator wake, a queued prompt or a resume still
runs; and that a `run --once` round settles a skipped runner as `no free entry`).

**Acceptance criteria.** All in `test/orchestrator-scheduling.test.ts`, using its
`fakeRunner`/`schedulingCtx` helpers:
- **Single runner, nothing eligible.** A runner with `ticks: 1` and `nextRunAt` in the past,
  in a root whose PLANS.md holds only a plan carrying a `**Refused …**` note (and, in a second
  case, no PLANS.md), is not admitted. Its `skipReason` is `"no-free-entry"` in memory and on
  disk (`loadLoopState`), and its `nextRunAt`/`backoffSeconds` are unchanged.
- **Once round, extra instance.** With `ONE_BLOCKED_PLAN` and two feature instances, a ctx
  whose `once` is `new OnceRound([feature, feature2], true)` has
  `once.reasons.get("feature-2") === "no free entry"` after one poll, and
  `once.isSettled(feature2)` is true. This fails before the change.
- **Once round, primary.** With no eligible plan, the primary is settled the same way in once
  mode once `ticks >= 1` (reason `"scheduled"`).
- **Still admitted.** The same nothing-eligible runner is admitted when:
  - its `wokenAt` is newer than `lastTickEndedAt`;
  - `ticks === 0` (reason `"startup"`);
  - it has a queued prompt in its inbox;
  - it carries a `revision`;
  - PLANS.md holds one eligible plan.
- **Unchanged tests.** The existing tests "an extra instance with no free entry is skipped and
  keeps its schedule", "an unassigned primary is told the entries its siblings hold, and the
  prompt names them" and "the bootstrap hold blocks maintenance through scheduling but admits
  plan and feature" pass without edits.
- **The project's check passes.** Any e2e test that relied on an unwoken feature tick against
  an empty backlog is adjusted to seed an eligible plan, and the entry names each such test in
  its Done note.


**Done 2026-10-12.** Landed as planned. The e2e test adjusted to seed an eligible plan: `ticks on the engaged fallback feed the breaker` in `test/orchestrator-fallback.test.ts`.

### Defer the plan loop's due ticks while PLANS.md already holds its eligible-plan target (planned 2026-10-12 by plan; independent of the backlog-writes series; done 2026-10-12)

**Goal.** Skip the plan loop's model run when it can only end with `TUMWATER_NOTHING_TO_DO`.
Today the plan charter stops once `## Planned` holds `planBacklogTarget(config)` eligible plans
(`src/scheduling/claims.ts`). The harness only states that target in the prompt
(`planTargetNote` in `src/tick/tick-prompt.ts`), so every "main moved" wake still runs a full
model tick that reads the backlog and stops. Plan is a work role, so it is not in
`DEFERRABLE_ROLES` (`src/roles/roles.ts`), and `deferTickReason`
(`src/scheduling/scheduling.ts`) never defers it.

**Approach.**
- **Fullness predicate.** Add `planBacklogFull(root, config): boolean` to
  `src/scheduling/claims.ts`, next to `planBacklogTarget`. It is true when both hold:
  - `eligibleEntries(root, "feature").length >= planBacklogTarget(config)`;
  - no entry of `backlogHolds(root).plans` is `"needs-review"` or `"needs-replan"`. The charter
    makes splitting or replanning a marked plan outrank the stop, so a marked entry keeps plan
    running.
- **Verdict.** Give `DeferReason` a third member, `"plans-full"`. Give `deferTickReason` a
  trailing `planBacklogFull = false` parameter, so existing call sites and tests are unchanged.
  When `baseRoleOf(role) === "plan"`, the function returns `"plans-full"` only if all of these
  hold, and returns `null` otherwise:
  - `planBacklogFull` is true;
  - there is no fresh wake (the same `wokenAt > lastTickEndedAt` test the maintenance clause
    uses);
  - `!hasOutstandingWork(s)`;
  - `s.lastMainHead !== ""`;
  - `!deferralExpired(s, now)`. This keeps the `DEFER_MAX_MS` cap, so a full backlog still
    gets one re-check per 3 h.

  Plan never reaches the maintenance clause, and `lastResult` does not matter for it.
- **Wiring.**
  - `src/orchestrator/orchestrator.ts` computes `planBacklogFull(root, liveConfig)` next to
    `workBacklogOpen`.
  - `SchedulingPassCtx` (`src/orchestrator/orchestrator-scheduling.ts`) gains a
    `planBacklogFull` field, and `pollRunnerReasons` passes it to `deferTickReason`.
  - The existing branch already handles everything else: it logs one `tick_deferred` per
    episode, settles `run --once` as `"deferred"`, and records the skip. Because it is gated
    on `reason === "scheduled" || reason === "main moved"`, a queued prompt (`inbox`) or a
    resume still runs.
- **Skip label.**
  - Add `"deferred-plans-full"` to `SkipReason` and `SKIP_REASONS` (`src/loop/loop-state.ts`).
  - Replace the `noteSkip` ternary with a three-way mapping.
  - Add a `loopPhase` case in `src/ui/status-model.ts` that renders `deferred (plans full)`.
  - The dashboard needs no change: `gui-client-model.ts` already parses any `deferred (…)`
    phase.
- **Event text.** `deferredReasonText` (`src/events/event-format.ts`) returns
  `"plan backlog at its target"` for `"plans-full"`. Update the `tick_deferred` comment in
  `src/events/events.ts`.

**Files.** `src/scheduling/claims.ts`, `src/scheduling/scheduling.ts`,
`src/orchestrator/orchestrator.ts`, `src/orchestrator/orchestrator-scheduling.ts`,
`src/loop/loop-state.ts`, `src/ui/status-model.ts`, `src/events/event-format.ts`,
`src/events/events.ts`, `test/claims.test.ts`, `test/scheduling.test.ts`,
`test/status-model.test.ts`, `test/event-format.test.ts`, docs/how-it-works.md (the Scheduling
bullet saying the plan loop keeps `instances(feature) + 1` eligible plans ahead gains: "a due
plan tick defers while that many are waiting and none is marked needs-review or needs-replan").

**Acceptance criteria.**
- `planBacklogFull` is tested in a temp repo:
  - true with two eligible plans and one feature instance;
  - false with one eligible plan;
  - false when one of three plans carries a `**Needs review …**` note;
  - refused plans and plans blocked by a prerequisite do not count toward the target.
- `deferTickReason` tests for role `"plan"` with `planBacklogFull` true:
  - returns `"plans-full"`;
  - returns `null` with a fresh `wokenAt`, with `resumePending: true`, or with `nextRunAt`
    more than `DEFER_MAX_MS` in the past.
- With `planBacklogFull` false, the plan verdict is `null`.
- Every existing `deferTickReason`/`deferTick` assertion passes unchanged.
- `loopPhase` renders `deferred (plans full)` for `skipReason: "deferred-plans-full"`.
- `deferredReasonText` renders the new clause for `reason: "plans-full"`, and the existing
  spellings for `"backlog"` and missing reasons are unchanged.

### A refusal note on a still-blocked plan is dropped, not landed (planned 2026-10-12 by plan; independent of every other entry) (done 2026-10-12)

A refusal note on a blocked plan holds it for good. On 2026-10-12, `feature-2` tick #99 refused "Operator backlog writes land on main, part 2/2" because part 1/2 had not landed (commit bd5019db). The heading's `requires part 1/2 landed` clause already held that plan as `[blocked: …]`, and that hold lifts by itself once part 1/2 leaves `## Planned`. The Refused note does not lift. It still holds part 2/2, two minutes after part 1/2 landed (11ddb628), until a human runs `tumwater plan --release`. It also paged the operator through `entry_refused`.

**Goal.** `handleRefusal` in `src/verdict/refusal.ts` drops a newly added Refused note from a PLANS.md `## Planned` entry that main still holds as blocked. Every other refusal note lands exactly as today.

**Approach.**
- **Pure helper in `src/verdict/refusal.ts`.** Add an exported `withoutBlockedPlanRefusals(baseMd: string, headMd: string): { md: string; dropped: string[] }`. It lives here, not in `backlog-eligibility.ts`, because `backlog-structure.ts` already imports `backlog-eligibility.ts`.
  - Base entries are `parseEntryDetails(baseMd, "Planned")` (`src/backlog/backlog-md.ts`), keyed by `entryKey(title)`, with `plannedPartKeys(basePlanned)` built once.
  - Walk head's `actionableEntryRanges(headMd, "Planned")` (`src/backlog/backlog-structure.ts`). Act on an entry only when all three hold:
    1. `refusalNote(slice.join("\n"))` (`src/backlog/backlog-eligibility.ts`) is non-null;
    2. the same key exists among the base entries, and `refusalNote(baseEntry.body)` is null;
    3. `entryHoldAgainst(baseEntry, baseParts)` returns an object with `blockedBy`.
  - Replace each such slice with `withoutRefusalNotes(slice)`, the same helper `releaseEntry` uses. Work from the last entry to the first so the earlier ranges stay valid.
  - Return the rewritten text and the dropped entries' titles. When nothing qualifies, return `headMd` unchanged and `dropped: []`.
- **Wiring in `handleRefusal`.** Before the `notes` list is computed, when `PLANS.md` exists in `wt`:
  - Read the base with `fileContentAt(wt, ctx.mainBranch, "PLANS.md")` (`src/git/git.ts`) and the head from disk, then run the helper.
  - When `dropped` is non-empty, write the result back to `path.join(wt, "PLANS.md")`. Log one event per title with `logEventBestEffort(ctx.root, { loop: ctx.role, type: "warning", message: \`dropped refusal note on blocked plan "<title>": its prerequisite is still planned, so the block already holds it\` })`.
  - Then compute `notes` from `changedFiles(wt)` as today. If PLANS.md is now clean and no other .md changed, the existing "no note" branch runs: reset to main, return `refused` with no commit, and emit no `entry_refused`. Any other markdown note, such as a BUGS.md refusal or a needs-review note, still commits and merges.
- **Unchanged.** `refusalContradiction`, `src/tick/tick-verdict.ts`, every role prompt, and refusal notes on entries that are eligible, not on main, or held another way (`refused`, `needs-review`, `needs-replan`).

**Files.** `src/verdict/refusal.ts` and `test/refusal.test.ts`. No README or docs/invariants.md change: no user-facing surface changes, and the guarantee is pinned by the new tests.

**Acceptance criteria.**
- New tests in `test/refusal.test.ts` use the existing `initializedWorktree` / `makeCtx` / `refusedPi` fixtures. Main's PLANS.md must hold both `### S, part 1/2: a (planned 2026-10-12 by plan)` and `### S, part 2/2: b (planned 2026-10-12 by plan; requires part 1/2 landed)` under `## Planned`.
- When the worktree adds `**Refused 2026-10-12 by feature: x**` under part 2/2, `handleRefusal` returns `result: "refused"` with no `commit`, makes no merge call, and leaves the worktree clean at main. The event log then holds a `warning` naming part 2/2 and no `entry_refused`.
- The same note on part 2/2 when main's PLANS.md lists part 1/2 under `## Done` instead commits and merges as today, and `entry_refused` is logged.
- When the blocked plan's note is added alongside a Refused note on an eligible entry, only the blocked plan's note is dropped. The commit carries the other note, and HEAD's PLANS.md lacks the dropped line.
- Unit tests of `withoutBlockedPlanRefusals` on in-memory strings:
  - head equal to base returns `dropped: []` and the same text;
  - a note already present on base is kept;
  - a dropped note that sat between blank lines leaves one blank line.
- The existing tests in `test/refusal.test.ts` and `test/loop-refusal.test.ts` pass unchanged.

### A queued prompt's delivery is logged: a `prompt_taken` event names the tick that took it (planned 2026-10-12 by plan; independent of every other entry. It touches no `src/backlog`, `src/landing`, `src/gui`, or `src/ui/tui` file. Today a queued prompt logs `prompt_enqueued` (`src/inbox/inbox-submit.ts`), `prompt_cancelled`, and `prompt_edited`, but nothing when a tick dequeues it. `assembleTickPrompt` in `src/tick/tick-prompt.ts` pops it with `dequeuePromptEntry`/`dequeueRolePromptEntry`, and `Loop.tickPrompt` in `src/loop/loop.ts` hands it to `PendingPrompt.record` without logging anything. So `tumwater logs`, the TUI/dashboard feeds, and `tumwater tick <role> <n>` cannot say which tick ran the operator's request. The prompt just drops off `tumwater prompt --list`. A grep for `"prompt_` in `src/events/events.ts` finds only `prompt_enqueued`, `prompt_cancelled`, and `prompt_edited`) (done 2026-10-12)

**Goal.** When a real tick dequeues a queued prompt (the director's or a per-role one), the event log records it under that loop, with the tick number and the prompt's preview. The tick's trail then shows which request it ran.

**Approach.**
- **Event type.** Add `"prompt_taken"` to the `HarnessEvent["type"]` union in `src/events/events.ts`, next to `prompt_edited`. Its trailing comment says that a tick dequeued a queued user prompt and that the event carries `tick` and `preview`.
- **Emit.** In `Loop.tickPrompt` (`src/loop/loop.ts`), after `assembleTickPrompt` returns non-null and `assembled.userPrompt !== null`, call `logEventBestEffort(this.root, { loop: this.role, type: "prompt_taken", tick: this.state.ticks, preview: promptPreview(assembled.userPrompt) })`. `promptPreview` comes from `src/inbox/inbox.ts` and `logEventBestEffort` from `src/events/events.ts`. `runTick` calls `tickPrompt` after `loop-tick.ts` has bumped `s.ticks` and logged `tick_start`, so `this.state.ticks` is the tick being run, and the event lands inside that tick's `tick_start`/`tick_end` block, which is what `tick-detail-data.ts` collects. `assembled.userPrompt` already has the not-before marker stripped.
- **Where not to emit.** Emit only in `Loop.tickPrompt`, never in `assembleTickPrompt`. The preview path (`preview: true`, used by `tumwater role <id>`) calls `assembleTickPrompt` directly and must stay silent. A resume that reclaims its re-queued copy (`reclaimForResume` in `src/tick/tick-resume.ts`) does not go through `tickPrompt` and logs nothing new. A prompt that is re-queued after an unfulfilled tick and taken again by a later fresh tick logs a second `prompt_taken`, which is accurate.
- **Render.** Add a `case "prompt_taken"` to `formatEvent` in `src/events/event-format.ts`, next to the other `prompt_*` cases: `` `user prompt taken by tick #${eventTick(e)}: ${textOr(e.preview)}` ``, using the `eventTick` helper from `src/events/event-read.ts`, as the `tick_start` case does. This is a plain routine line with no warning prefix. `eventKind` (`src/ui/tone.ts`) and its browser twin in `src/ui/gui/gui-client-model.ts` need no change: an unlisted type is `"info"`, as its `prompt_enqueued` sibling is.
- **Not in scope.** No notify-allowlist entry (`NOTIFY_EVENT_TYPES` stays as is), no history or report column, and no change to the queue files or the `PendingPrompt` re-queue policy.

**Files.** `src/events/events.ts`, `src/loop/loop.ts`, `src/events/event-format.ts`, `test/event-format.test.ts`, `test/loop-prompt-requeue.test.ts` (or a sibling loop test using `makeLoopRunner` and `withPi`).

**Acceptance criteria.**
- New loop test: `enqueueRolePrompt(repo, "perf", "fix the flubbernator")`, then one `runner.tick()` under a fake pi that answers `TUMWATER_NOTHING_TO_DO`. The event log then holds exactly one `prompt_taken` event with `loop: "perf"`, `tick` equal to that tick's `tick_start` tick, and a `preview` containing `flubbernator`. A second tick with an empty queue adds no `prompt_taken`.
- A tick that runs with no queued prompt logs no `prompt_taken`.
- Assembling the preview (`assembleTickPrompt({ …, preview: true })`) with a prompt queued logs no `prompt_taken`, and the prompt stays queued.
- `formatEvent({ ts: 0, loop: "perf", type: "prompt_taken", tick: 7, preview: "fix x" })` returns a line containing `user prompt taken by tick #7: fix x`. If `test/event-format.test.ts` has a list that renders every type, it includes `prompt_taken`.
- The project's check (`npm run test`) passes.


### A landed refusal note pages the operator: a new `entry_refused` event joins the notify allowlist (planned 2026-10-12 by plan; independent of the refused "Operator backlog writes land on main" part 2/2 above; done 2026-10-12)

**Goal.** When a tick's **Refused** note lands on main, the operator hears about it the same way they hear about a posted question. Only a human or the director can lift a refusal (`tumwater plan|bug --release <n>`). Until then the entry is held, and a fully refused backlog leaves feature or bugfix with nothing to do. Today the only trace is a `tick_end` with result `refused`, which is not a notify type. So a refusal nobody reads holds an entry until someone happens to run `tumwater doctor`, as the refused part 2/2 above shows.

**Approach.**
- **Context.** `RefusalContext` in `src/verdict/refusal.ts` gains `root: string`. `resolveTickVerdict` in `src/tick/tick-verdict.ts` passes `ctx.root` (its `TickVerdictContext` already carries `root`).
- **Emission.** In `handleRefusal`, after `ctx.merge(...)` returns `"changed"` (the branch that already calls `clearSupersededRejection`), call `logEventBestEffort(ctx.root, { loop: ctx.role, type: "entry_refused", reason, files: notes })`. `notes` is the `.md` list the note commit staged. No event is logged on the paths that land nothing: the no-commit reset and a merge result other than `"changed"`. Best-effort, because the note has already landed.
- **Type.** Add `| "entry_refused"` to `HarnessEvent["type"]` in `src/events/events.ts`, with a trailing comment in that union's style: "a refusal tick's objection note landed on main (src/verdict/refusal.ts handleRefusal); carries reason and files — the entry stays held until a human or the director lifts it".
- **Rendering.** `formatEvent` in `src/events/event-format.ts` gets a `case "entry_refused"` rendering `entry refused: <reason> (<files joined by ", ">)`, using `textOr` for the reason. There is no warning prefix, matching `question_posted`.
- **Kind.** `eventKind` in `src/ui/tone.ts` and its browser twin `eventKind` in `src/ui/gui/gui-client-model.ts` both return `"attention"` for `entry_refused`, next to the `question_posted` line.
- **Notify.** Append `"entry_refused"` to `NOTIFY_EVENT_TYPES` in `src/events/notify.ts`, with the comment "a refusal note landed — the entry is held until a human or the director releases it". Add it to the allowlist list in the `notify` doc comment in `src/config/config-schema.ts`. Add "a refused backlog entry" to README.md's notify sentence, after "a posted question".

**Files.** `src/verdict/refusal.ts`, `src/tick/tick-verdict.ts`, `src/events/events.ts`, `src/events/event-format.ts`, `src/ui/tone.ts`, `src/ui/gui/gui-client-model.ts`, `src/events/notify.ts`, `src/config/config-schema.ts`, README.md, `test/refusal.test.ts`, `test/event-format.test.ts`, `test/notify.test.ts`, `test/gui-client.test.ts`.

**Acceptance criteria.**
- `test/refusal.test.ts`: `makeCtx` takes the fixture's `root` (from `initializedWorktree`). The note-landing test then finds exactly one `entry_refused` event in `readEvents(root)`, with `loop: "improve"`, `reason: "it would delete user data"`, and `files` containing `PLANS.md`. "a refusal with no note resets the worktree and never merges" and "a failed note merge records lastError and still reports the commit" each find none.
- `test/event-format.test.ts`: a new test shows `formatEvent` rendering an `entry_refused` event as `entry refused: <reason> (PLANS.md)`, with no `warning` substring.
- `test/notify.test.ts`: the pinned `NOTIFY_EVENT_TYPES` list includes `"entry_refused"`.
- `test/gui-client.test.ts`: `kind("entry_refused")` is `"attention"`, and `eventKind("entry_refused")` from `src/ui/tone.ts` agrees.
- `npm run test` passes.


### `tumwater plan|bug --release <n>` lifts a stale **Refused** note and commits the release on main (planned 2026-10-12 by plan; independent of the refused "Operator backlog writes land on main" part 2/2 above. It touches `src/backlog/backlog-write.ts` and `src/cli.ts`, which that plan also touches, but in different functions and `case` arms. Today a Refused note can only be cleared by hand-editing the file, or by rewriting the whole entry with `--edit <n> --file`. Both leave an uncommitted edit in the primary checkout. `checkRefusedEntries`' remedy says "answer the objection and delete the note" but names no command for it. The part 2/2 entry above is stuck this way right now: its refusal cites a missing `src/backlog/backlog-commit.ts`, and that file has since landed. A grep for `--release` or `unrefuse` under `src/` finds nothing, and the `reopen` hits there are about the budget gate and drawers, not backlog entries) — done 2026-10-12

**Goal.** The operator releases a refused entry with one command. `tumwater plan --release 1` (and `bug --release <n>`) deletes the Nth entry's Refused note line, commits the file on main, wakes the loop that will now pick the entry up, and prints `released plan in PLANS.md: <title>`. The doctor refusals row names this command as the remedy.

**Approach.**
- **Pure helper.** In `src/backlog/backlog-eligibility.ts`, beside `refusalNote`, export `withoutRefusalNotes(lines: string[]): string[]`. It drops every line whose `trimStart()` begins with the private `REFUSED_PREFIX`, the same line-prefix rule `hasNoteLine` applies. When a dropped line had a blank line (`trim() === ""`) directly before it and directly after it in the input, it also drops the blank line after it, so `heading, "", note, "", **Goal.**` becomes `heading, "", **Goal.**`. Needs-review and needs-replan notes and every other line are left as they are.
- **Writer.** In `src/backlog/backlog-write.ts`, add `export function releaseEntry(root: string, kind: "bug" | "plan", n: number): { file: string; title: string }`.
  - It holds `withStateLock(primaryWorktreeLockPath(root), …)`, as `removeEntry`/`editEntry` do. It calls `readEntryLines(root, fileName, sectionTitle, n)`, using the `PLANS.md`/`Planned` and `BUGS.md`/`Open` pairs `tryCancelEntry` uses, so an out-of-range position fails with `locateEntry`'s existing wording.
  - It runs `withoutRefusalNotes` over the entry's slice `lines.slice(entry.start - 1, entry.end)`. If nothing was dropped, it fails with `` `${kind} #${n} "${entry.title}" carries no Refused note` `` and writes nothing. Otherwise it splices the slice back in, writes with `writeTextAtomic`, and returns `{ file: fileName, title: entry.title }`.
- **CLI shell.** Add `export async function releaseAndAnnounce(root, args, command: "bug" | "plan", release: (n: number) => { file: string; title: string }, role: string)`.
  - Parse the flags the way `cancelAndAnnounce` does: `--release <n>` through `parsePositionFlag("--release", …, "--release 2")`, an optional `--json`, repeats refused through `rejectRepeatFlag`, `--help`/`-h` skipped, and anything else refused through `rejectUnknownArgs(command, rest, [])`. A missing position fails with `--release needs a position (usage: tumwater ${command} --release <n>)`.
  - Then: `await requireReadyRepo(root)`, call `release(position)`, then `await commitOperatorBacklogEdit(root, released.file, stampedSubject("operator", `Release ${command}: ${released.title}`))`, then `requestWake(root, [role])` (`src/operator/operator-intent.ts`).
  - Output: in `--json` mode, print `sayJson({ file, title })` only. Otherwise print `released ${command} in ${file}: ${title}` followed by the wake confirmation line.
  - Why a plain wake: the released entry is now eligible, and the target loop may be backed off for hours. `submitRolePromptAndWake`'s filing text does not fit a release, so the wake carries no queued prompt.
- **Dispatch.** In `src/cli.ts`, the `bug` and `plan` cases each add an `if (args.includes("--release"))` arm next to the `--cancel` arm. The arms pass `(n) => releaseEntry(root, "bug" | "plan", n)` and `OPERATOR_FILE_KINDS.<kind>.role`.
- **Doctor remedy.** In `checkRefusedEntries` (`src/doctor/doctor-backlog.ts`), the tail becomes `` answer the objection and release the entry with `tumwater ${first.command} --release ${first.position}`, or retract it with `tumwater ${first.command} --cancel ${first.position}` ``. Update the doc comment above the function to match: an operator release clears the note, as a human or director edit does. Keep the rest of the detail text as it is.
- **Out of scope.** No dashboard or TUI control: a release is a rare, deliberate operator act. No change to `entryHold`/`hasNoteLine`. No release for needs-review or needs-replan notes, because the plan role resolves those itself.

**Files.** `src/backlog/backlog-eligibility.ts`, `src/backlog/backlog-write.ts`, `src/cli.ts`, `src/cli/help.ts` (a `tumwater bug --release <n> [--json]` and a `tumwater plan --release <n> [--json]` line, each next to its `--cancel` line), `src/doctor/doctor-backlog.ts`, `test/backlog-eligibility.test.ts`, `test/backlog-write-cancel.test.ts` (the `releaseEntry` cases, beside the cancel ones), `test/backlog-commit.test.ts` (the CLI release cases, which use `initializedRepo`/`assertClean`/`cli` there), `test/doctor-backlog.test.ts` if it asserts the remedy text (today's grep for "retract the entry" finds it only in `src/`), and README.md (the "Steer the project" row's `--cancel <n>` clause gains "`--release <n>` lifts a Refused note and commits it on main, waking the loop", and the Audit row's refusals clause names `--release`).

**Acceptance criteria.**
- `withoutRefusalNotes(["### t", "", "**Refused 2026-10-12 by feature: x**", "", "**Goal.** g"])` returns `["### t", "", "**Goal.** g"]`. A note indented by two spaces is dropped too. A line that only mentions `**Refused ` mid-sentence is kept. A `**Needs review …**` line is kept.
- In a repo on main with a PLANS.md holding a refused plan at position 2: `tumwater plan --release 2` leaves `git status --porcelain` empty. HEAD's subject is `tumwater(operator): Release plan: <title>` as `stampedSubject` builds it. The entry's body no longer holds the note, every other line of the file is unchanged, and `tumwater plan --list` no longer marks the entry `[refused]`.
- `tumwater bug --release 1` on a refused open bug behaves the same for BUGS.md (subject `… Release bug: <symptom>`).
- `--release 1` on an entry without a Refused note, or `--release 9` past the end, exits non-zero with the wording above. The file is unchanged and HEAD is unchanged.
- `--json` prints exactly the object `{file: "PLANS.md", title: "<title>"}` (as `sayJson` formats it, like `--cancel`), with no wake line on stdout.
- `checkRefusedEntries`' warn detail ends with `` release the entry with `tumwater plan --release 1`, or retract it with `tumwater plan --cancel 1` `` for a refused first plan.
- Existing tests in `test/backlog-write-cancel.test.ts`, `test/backlog-write-edit.test.ts`, and `test/backlog-commit.test.ts` pass unchanged.

### The TUI schedules and cancels a graceful fleet stop with Ctrl+Q (`tumwater stop --in` / `--cancel` parity) (planned 2026-10-12 by plan; independent of every other entry; follows the landed "The dashboard schedules and cancels a graceful fleet stop" entry in Done) — done 2026-10-12

**Goal.** `tumwater stop --in 2h` / `stop --cancel` and the dashboard's "Stop the fleet later" control can set and drop a scheduled stop. The TUI shows the resulting `stops in …` badge (through `runWindowBadge` in `src/ui/status-render.ts`) but cannot set or drop it. An operator watching the terminal should be able to say "wind down in 2 hours", or take that back, without a second terminal. This is the same reasoning that gave the TUI Ctrl+F for the fleet pause.

**Approach.** Model the key on Ctrl+F: it toggles by marker state, and it reuses the pause editor's machinery with one more flag, as Ctrl+W did with `pauseEditWake`. The key is **Ctrl+Q** (mnemonic: **q**uit later). It is unbound today: a grep for `"q"` under `src/ui/tui` finds nothing, and node's raw TTY mode clears IXON, so the terminal delivers it.
- **Parser (`src/ui/tui/tui-input.ts`).** Add `parseStopInInput(text): { ok: true; inMs: number } | { ok: false; error: string }` beside `parseRoleWakeInput`.
  - It trims the text. Empty → `{ ok: false, error: "a scheduled stop takes a duration like 45m or 2h — Esc to cancel" }`.
  - A string `parseDurationMs` rejects → the same error.
  - A duration over `PAUSE_FOR_MAX_MS` → `"stop is capped at 90d"`.
  - Otherwise → `{ ok: true, inMs }`.
  - Empty is refused on purpose: an immediate stop has its own command, and this key must never mean "stop now".
- **Keys (`src/ui/tui/tui-keys.ts`, `createTuiKeys`).**
  - Add `let pauseEditStop = false`. Expose it on `TuiKeysState` as `pauseEditStop: boolean`, with a doc comment ("the fleet editor schedules a stop (Ctrl+Q) rather than a pause (Ctrl+F)"), and return it from `state()`. `exitPauseEditMode` resets it, as it does `pauseEditWake`.
  - Add a `key.ctrl && key.name === "q"` branch right after the Ctrl+F branch, with the same guard: `!budgetMode && !rolePromptFor && !searchMode && !deferMode && !queuedEditFor && !answerFor && !entryEditFor`. Inside a `try`/`catch` that calls `flashError`, as Ctrl+F does:
    - If `pauseEditMode` is open (any pause, wake, or stop editor), `exitPauseEditMode()` and return. A second Ctrl+Q closes the editor without writing.
    - Else, if `scheduledStopAt(root) !== undefined` (from `src/fleet/fleet-state.ts`), `flashMessage(cancelScheduledStopMessage(root))`. This is an immediate cancel, like Ctrl+F's immediate resume.
    - Else, settle the prompt recall and save the draft into `pauseSavedInput`/`pauseSavedCursor`, exactly as Ctrl+F does. Set `pauseEditMode = true`, `pauseEditRole = null`, and `pauseEditStop = true`, blank the line, and flash `'stop the fleet later: a duration, e.g. "2h" — in-flight ticks finish, then the fleet exits — Enter to schedule, Esc to cancel'`.
  - In the Enter handler's `pauseEditMode` branch, before `wakeParsed`/`parsed` are used, handle `pauseEditStop`. Run `parseStopInInput(input)`:
    - Not ok → `flashMessage(error)` and stay in the editor.
    - Ok → `const result = requestScheduledStop(root, inMs)`, then `exitPauseEditMode()`. Flash `result.ok ? result.message : \`error: ${result.error}\``, the abort key's error idiom.
    - Both functions come from `src/operator/operator-intent.ts`, already imported for `requestWake`/`requestAbort`, so the TUI writes the same marker with the same wording as `cmdStop` and `/api/stop-schedule`.
- **Frame (`src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`).**
  - Add `pauseEditStop?: boolean` to the `mode` parameter types of `hintLine` and `promptPrefix`.
  - With `pauseEditMode && pauseEditStop`, the prompt prefix reads `stop in › ` and the hint's Enter label reads `schedule stop`. Today's fleet-pause branch keeps `pause`.
  - The default (activity) view's hint keys gain `["Ctrl+Q", "stop later"]` right after `["Ctrl+F", "pause fleet"]`.
  - In `tui.tsx`, the `mode` object passes `pauseEditStop: s.pauseEditStop`.
- **Docs.**
  - README.md's "Control the loops" row: at the `stop --in` sentence, add that the TUI's Ctrl+Q sets it (a duration) and, when one is already scheduled, cancels it.
  - docs/how-it-works.md: add one sentence after the `Ctrl+F` paragraph describing Ctrl+Q the same way.
  - Update the TUI's module doc comment in `test/tui-operator-keys.test.ts` to name Ctrl+Q.
  - docs/invariants.md: no new guarantee; the marker semantics are unchanged.

**Files touched.** `src/ui/tui/tui-input.ts`, `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`, `README.md`, `docs/how-it-works.md`, `test/tui-input.test.ts`, `test/tui-operator-keys.test.ts`, `test/tui-frame.test.ts`.

**Acceptance criteria.**
- `test/tui-input.test.ts`: `parseStopInInput("2h")` → `{ ok: true, inMs: 7_200_000 }`. `""`, `"soon"`, and `"91d"` each → `ok: false`; the last one's error matches `/capped at 90d/`.
- `test/tui-operator-keys.test.ts`, using `makeTuiRepo`/`withTui`, `writeOrchestratorMarker` from `test/fixtures/log-fixtures.ts` (a live harness), and `scheduledStopAt` from `src/fleet/fleet-state.ts`:
  - Ctrl+Q opens the editor: the last line matches `/^stop in ›/`, and no marker is written yet. Typing `2h` and Enter (with a live harness) sets `scheduledStopAt(repo)` within 60 s of `Date.now() + 7_200_000`, and the frame matches `/stop scheduled in 2h/`.
  - With a marker already present, Ctrl+Q removes it at once and the frame matches `/scheduled stop cancelled/`. No editor opens.
  - With no harness running, Ctrl+Q, `2h`, Enter flashes `/error: no harness is running/` and writes no marker.
  - An empty Enter or `91d` flashes the parser's error, writes nothing, and keeps the editor open. Esc then restores a typed draft on the `director ›` line. A second Ctrl+Q closes the editor without writing.
  - Ctrl+Q during a `/` search, or while the budget editor (Ctrl+B) is open, opens no `stop in ›` editor and writes no marker.
- `test/tui-frame.test.ts`: `hintLine` on the activity view names `Ctrl+Q`. With `pauseEditMode: true, pauseEditStop: true`, `promptPrefix` renders `stop in` and `hintLine` renders `schedule stop`.
- The existing Ctrl+F and Ctrl+W tests in `test/tui-operator-keys.test.ts` pass unchanged.

### The dashboard schedules and cancels a graceful fleet stop (`tumwater stop --in` / `--cancel` parity) (done 2026-10-12; planned 2026-10-12 by plan; independent of every other entry; follows the landed "`tumwater stop --in <duration>`" entry in Done)

**Goal.** `tumwater stop --in 2h` and `stop --cancel` exist only on the CLI. The dashboard shows the resulting `stops in …` row but can neither set nor drop it. Its row also always reads "This run was started with run --for", even when the deadline came from a `stop --in` marker. An operator watching the dashboard should be able to say "wind down in 2 hours", or take that back, without a terminal.

**Approach.**
- **Shared core (`src/operator/operator-intent.ts`).** Add two functions beside `requestRestart`, so the CLI and the dashboard cannot drift:
  - `requestScheduledStop(root, inMs): RequestResult` returns `{ ok: false, error: NO_HARNESS_ERROR }` unless `orchestratorAlive(root)`. Otherwise it calls `scheduleStop(root, Date.now() + inMs)` (from `src/fleet/fleet-state.ts`) and returns `cmdStop`'s current confirmation as `message`: `` stop scheduled in ${durationLabel(inMs)} — the fleet drains its in-flight ticks and exits then; `tumwater stop --cancel` drops it ``.
  - `cancelScheduledStopMessage(root): string` returns `cancelScheduledStop(root) ? "scheduled stop cancelled" : "no stop scheduled"`.
- **`cmdStop` in `src/operator/operator-commands.ts`.**
  - The `--cancel` branch says `cancelScheduledStopMessage(root)`.
  - The `--in` branch keeps its `parseDurationFlag`/`failOverDurationCap` validation, then calls `requestScheduledStop`: it `say`s the message on ok and `fail`s with the error otherwise. Move the `--in` branch ahead of the plain-stop liveness gate, so the gate no longer runs twice.
  - Plain `stop` is unchanged. So is every printed string (the existing `test/scheduled-stop.test.ts` cases pin them).
- **Route (`src/gui/gui-endpoint-commands.ts`, `src/gui/gui-server.ts`).** Add `handleStopSchedule` and register it as `"POST /api/stop-schedule"` in the route table next to `/api/restart`.
  - Read the body with `readPostBody(req, res, '{"inSeconds": 7200}')`.
  - `{"cancel": true}` answers 200 `{ ok: true, message: cancelScheduledStopMessage(root) }`. Like the CLI, cancel does not need a live fleet.
  - Otherwise `inSeconds` is required: an absent one answers 400 `{ error: "inSeconds or cancel is required" }`. A present one goes through the existing `wakeInSecondsMs`, which already enforces positive, finite, and the `PAUSE_FOR_MAX_MS` cap with its 400 wording. Then send `sendRequestResult(res, requestScheduledStop(root, ms))`, so a stopped fleet answers 409 with `NO_HARNESS_ERROR`.
  - `cancel` together with `inSeconds` answers 400 `{ error: "cancel and inSeconds cannot be combined" }` and writes nothing.
- **Payload (`src/status/status-data.ts`, `src/ui/status-payload.ts`).** Add `scheduledStopAt?: number` to the snapshot. It is `scheduledStopAt(root)`, set only while `running`, beside the existing `runStopsAt` merge. `statusPayload` spreads it as a raw field with the same omit-when-undefined idiom `runStopsAt` uses. `runStopsAt` and `runWindowBadge` are unchanged.
- **Client (`src/ui/gui/gui-page.ts`, `src/ui/gui/gui-client-operator.ts`, `src/ui/gui/gui-client-fleet.ts`, `src/ui/gui/gui-client-boot.ts`).**
  - Add `<div class="menu-anchor up" id="stopwrap"></div>` after `pausewrap` in `.side-controls`.
  - In `gui-client-operator.ts`, add a `stop-control:start`/`:end` block modelled on the pause control (`openPopover`, a `stopMenuOpen` flag, and a `renderStopControl(d)` called wherever `renderPauseBadge` is):
    - With `!d || !d.running`, the panel is empty.
    - With `d.scheduledStopAt` set, the panel is a `btn btn-warn` with `id='stopbadge'` that reads "Cancel scheduled stop". Clicking it posts `{cancel: true}`.
    - Otherwise, the panel is a `btn` with `id='stopbadge'` reading "Stop the fleet later". It opens a menu of `STOP_CHOICES = [[3600, "In 1 hour"], [7200, "In 2 hours"], [14400, "In 4 hours"], [28800, "In 8 hours"]]` as `data-stopin` items, plus the hint "In-flight ticks finish, then the fleet exits."
    - Both post through `postAction("/api/stop-schedule", …, (d) => d && typeof d.message === "string" ? d.message : "…")`.
    - The control offers no immediate stop: when the dashboard is served by `run --gui`, an immediate stop would take the page down mid-click.
  - In `gui-client-fleet.ts`, the `runWindowBadge` row's explanation reads "A scheduled stop (tumwater stop --in) — the fleet drains in-flight work and exits then." when `d.scheduledStopAt === d.runStopsAt`, and keeps today's `run --for` text otherwise.
- **Docs.** In README.md's "Control the loops" row, at the `stop --in` mention, add that the dashboard's "Stop the fleet later" control sets and cancels it. In `docs/invariants.md`, add no new guarantee: the marker's semantics are unchanged.

**Files touched.** `src/operator/operator-intent.ts`, `src/operator/operator-commands.ts`, `src/gui/gui-endpoint-commands.ts`, `src/gui/gui-server.ts`, `src/status/status-data.ts`, `src/ui/status-payload.ts`, `src/ui/gui/gui-page.ts`, `src/ui/gui/gui-client-operator.ts`, `src/ui/gui/gui-client-fleet.ts`, `README.md`, `test/gui-endpoints.test.ts`, `test/gui-client-sidebar.test.ts`, `test/status-payload.test.ts`.

**Acceptance criteria.**
- In `test/gui-endpoints.test.ts`, using its `fakeReq`/`captureJson` helpers and a `seedFleet`-style live info file (pid = `process.pid`):
  - `handleStopSchedule` with `{"inSeconds": 7200}` answers 200 with a message matching `/stop scheduled in 2h/`. Afterwards `scheduledStopAt(root)` is within a few seconds of `Date.now() + 7_200_000`.
  - With no info file, the same body answers 409 matching `/no harness is running/` and writes no marker.
  - `{"cancel": true}` answers `scheduled stop cancelled` and removes the marker. A second call answers `no stop scheduled`.
  - `{}`, `{"inSeconds": -1}`, `{"inSeconds": 8000000}` (over 90 days), and `{"cancel": true, "inSeconds": 60}` each answer 400 and leave no marker.
  - The live server routes `POST /api/stop-schedule`, and a `GET` of that path is refused, as the `/api/restart` routing test checks.
- In `test/status-payload.test.ts`, a running snapshot with a stop marker carries `scheduledStopAt` in the payload. A stopped one omits it.
- In `test/gui-client-sidebar.test.ts` (or the operator-control test that already exercises `renderPauseBadge`, whichever scope exposes it):
  - The stop control is empty when not running. It reads "Stop the fleet later" when running with no marker, and "Cancel scheduled stop" when `scheduledStopAt` is set.
  - The `Stops in` row's explanation names `stop --in` when `scheduledStopAt === runStopsAt`, and `run --for` otherwise.
- The `stop` tests in `test/scheduled-stop.test.ts` and `test/cli-operators-fleet.test.ts` pass unchanged, so the CLI output is unchanged.

### `tumwater retire --role <id> --dry-run` previews what retire would remove and whether its safety rails would refuse (planned 2026-10-12 by plan; independent of every other entry) (done 2026-10-12)

**Goal.** `retire` deletes a loop's branch and worktree, or resets a pooled slot with `reset --hard` and `clean -fd`. Today the only way to learn what it will touch is to run it. It refuses when a safety rail objects, and then the operator has to choose blind between fixing each objection and `--force`. `reclaim` and `init` already offer `--dry-run`. `retire --dry-run` should give the same preview: which artifacts exist to remove, which are already gone, and which rails object. It changes nothing.

**Approach.**
- **`src/operator/retire.ts`.** Add `export async function previewRetire(root, role): Promise<RetirePreview>`, where `RetirePreview` is `{ status: RetireStatus; wouldRemove: string[]; skipped: string[]; objections: string[] }`.
  - It calls `collectRetire(root, role)`. That call keeps throwing on an unreadable tumwater.json, as `retireRole` does today.
  - It classifies each of `ARTIFACTS` in order, using the same presence test `retireRole`'s `mark` calls use: `worktree` ⇐ `status.worktreePresent`, `branch` ⇐ `status.branchPresent`, `landingRef` ⇐ `status.landingRefPresent`. For `pausedMarker`, it checks `pausedRoles(root).includes(role)` (import `pausedRoles` from `src/fleet/fleet-state.ts`) instead of calling `resumeRole`.
  - `objections` is the existing private `objections(status)` result. It writes no file, ref, or slot state and runs no state-changing git command.
- **`cmdRetire` in `src/operator/operator-commands.ts`.** When `args.includes("--dry-run")`, call `previewRetire` instead of `retireRole`, and render:
  - one `would remove <artifactPhrase>` line per `wouldRemove` entry;
  - one `nothing to remove: <artifactPhrase>` line per `skipped` entry, the same wording the real run uses;
  - then one line per objection: `would refuse: <reason>` without `--force`, or `--force overrides: <reason>` with it;
  - finally `dry run — nothing removed`.
  - With `--json`, print `{ role, dryRun: true, wouldRemove, skipped, objections }`. The exit code is 0 even when rails object, because this is a preview, like `reclaim --dry-run`.
- **`src/cli.ts`, `case "retire"`.** Add `DRY_RUN_FLAG`, imported from `src/cli/cli-flag-specs.ts` next to `FORCE_FLAG`, to the `rejectUnknownArgs("retire", …)` list. Widen `DRY_RUN_FLAG`'s doc comment, which today says it previews a reclaim pass, to name retire too.
- **Docs.** In `src/cli/help.ts`'s retire stanza, add `--dry-run lists what would be removed and any objections, changing nothing`. In README.md's "Control the loops" row, add `--dry-run` to the `tumwater retire` mention.

**Files touched.** `src/operator/retire.ts`, `src/operator/operator-commands.ts`, `src/cli.ts`, `src/cli/cli-flag-specs.ts` (comment only), `src/cli/help.ts`, `README.md`, `test/retire.test.ts`.

**Acceptance criteria** (all in `test/retire.test.ts`, using its `initializedWorktree`/`disableRole` fixtures and the `cli` harness):
- Disable `improve` and pin a merged landing ref, as the first retire test does. Then `cli(root, "retire", "--role", "improve", "--dry-run", "--json")` exits 0 with `wouldRemove` `["worktree", "branch", "landingRef"]`, `skipped` `["pausedMarker"]`, and `objections` `[]`. Afterwards the worktree directory, the branch (`branchHead` non-null), and the landing ref all still exist.
- For an enabled role (`feature`), `--dry-run` exits 0. Its text output has a `would refuse:` line matching `/still enabled in tumwater.json/` and ends with `dry run — nothing removed`. Adding `--force` prints that reason after `--force overrides:` instead, and still removes nothing.
- With `pausedRolesPath` holding `["improve", "clean"]`, `previewRetire(root, "improve")` lists `pausedMarker` in `wouldRemove`, and the marker still reads `["improve", "clean"]` afterwards.
- On a pinned slot, `--dry-run` leaves `readSlotsState(root)`'s `pinnedFor` for that slot unchanged.
- `cli(root, "retire", "--role", "improve", "--dry-runn")` fails with `unknown argument: --dry-runn`. `helpTopic("retire")` matches `/--dry-run/`.
- The existing retire tests pass unchanged.

### `tumwater stop --in <duration>` schedules a graceful stop of the running fleet, shown as `stops in …` everywhere `run --for` is (done 2026-10-12; planned 2026-10-12 by plan; independent of every other entry; follows the landed "`run --for` shows a `stops in` countdown" plan, whose `StatusSnapshot.runStopsAt` and `runWindowBadge` it reuses)

**Goal.** A deadline can only be set when a fleet starts (`run --for`). An operator who started an unbounded `tumwater run` and later wants it to end tonight can either kill it now (`tumwater stop`) or restart it under `--for`, and a restart loses in-flight ticks. `tumwater stop --in 2h` should set that deadline from any terminal, and `tumwater stop --cancel` should drop it. `wake --in` and `pause --for` already schedule their own actions this way.

**Approach.**
- **Marker.** Add `scheduledStopPath(root)` in `src/paths.ts` beside `pausedPath`, pointing at `.tumwater/stop-at.json` with body `{ at, until }` in epoch ms. Add three functions to `src/fleet/fleet-state.ts` beside `pauseFleet`/`resumeFleet`, using the same `readJsonFile`/`writeJsonAtomic`/`removeQuiet` helpers:
  - `scheduleStop(root, untilMs)` overwrites the marker, so the last write wins.
  - `scheduledStopAt(root): number | undefined` never throws. A missing, unreadable, or non-finite `until` reads `undefined`.
  - `cancelScheduledStop(root): boolean` reports whether a marker was there, the same changed-state contract as `resumeFleet`.
- **Flags.** In `src/cli/cli-flag-specs.ts`, turn `WAKE_IN_FLAG`'s body into a factory, `inFlagSpec(command)`. The factory builds the `missingValue` text and the `validate` label from `command`, so wake's wording stays byte-identical. Then:
  - `WAKE_IN_FLAG = inFlagSpec("wake")`
  - add `STOP_IN_FLAG = inFlagSpec("stop")` and `STOP_CANCEL_FLAG = { names: ["--cancel"] }`.
  - In `src/cli.ts`'s `case "stop"`, change `rejectUnknownArgs("stop", args, [])` to accept those two specs, and pass `args` to `cmdStop`.
- **Command.** `cmdStop(root, args = [])` in `src/operator/operator-commands.ts`:
  - `--in` together with `--cancel` fails with `stop --cancel and --in cannot be combined`.
  - `--cancel` needs no live harness. It calls `cancelScheduledStop` and says either `scheduled stop cancelled` or `no stop scheduled`.
  - `--in <d>` keeps today's liveness gate: `readOrchestratorInfo` plus `pidAlive`, otherwise `fail(NO_HARNESS_ERROR)`. It re-parses with `parseDurationFlag("stop --in", …)`, applies the `PAUSE_FOR_MAX_MS` cap, calls `scheduleStop(root, Date.now() + ms)`, and says `stop scheduled in <durationLabel(ms)> — the fleet drains its in-flight ticks and exits then; \`tumwater stop --cancel\` drops it`. It sends no signal.
  - With neither flag, behaviour is unchanged.
- **Firing.** Add `armScheduledStopWatch(root, onStop)` in `src/cli/cli-run.ts` beside `armDeadlineTimer`, returning `{ clear }`:
  - It runs an unref'd `setInterval` every `SCHEDULED_STOP_POLL_MS = 5000` ms.
  - When `scheduledStopAt(root)` is defined and at or before `Date.now()`, it removes the marker (`cancelScheduledStop`), clears itself, prints `scheduled stop reached — stopping`, and calls `onStop`.
  - `cmdRun` arms it in the supervised generation next to `deadlineTimer`, passing the same `stop` closure, so the drain runs the same code path as Ctrl+C. It is cleared in the same `finally`.
  - A self-redeploy leaves the marker in place, so the next generation's watch picks it up.
- **Stale markers.** In `cmdRun`'s unsupervised branch (`!process.env[SUPERVISED_ENV]`), call `cancelScheduledStop(root)` right after the "already running" gate and before `superviseRunCommand`. A marker left by a fleet that died before its deadline then cannot stop the next `tumwater run`.
- **Countdown.** In `src/status/status-data.ts`, the `runStopsAt` field becomes the earlier of `info.stopsAt` and `scheduledStopAt(root)`, still only while `running`. `runWindowBadge`, `statusPayload`, the TUI header, and the dashboard sidebar then show `stops in …` without edits of their own. Update the `runStopsAt` doc comment to name both sources.
- **`run --for` summary.** A `run --for` fleet that a scheduled stop ends early still prints its window summary. The existing `forMs !== null && !exit.restart` branch handles that unchanged.

**Files.**
- `src/paths.ts`
- `src/fleet/fleet-state.ts`
- `src/cli/cli-flag-specs.ts`
- `src/cli.ts`
- `src/operator/operator-commands.ts`
- `src/cli/cli-run.ts`
- `src/status/status-data.ts`
- `src/cli/help.ts`: the `tumwater stop` line gains `[--in <duration> | --cancel]`
- README.md: the "Control the loops" row's `tumwater stop` text
- `docs/invariants.md`: a new INV-B entry under "Reader and writer over a persisted or appended file". The guarantee: a scheduled stop fires once, is consumed when it fires, and is cleared at a fresh `run`. Pin it to the new tests.
- Tests: `test/operator-commands.test.ts` (beside the existing `cmdStop` tests) and a status-data test.

**Acceptance criteria.**
- `cmdStop(root, ["--in", "2h"])` with a live recorded pid writes `stop-at.json` with `until` about 2h ahead, sends no signal, and prints `stop scheduled in 2h …`. With no info file it fails with `NO_HARNESS_ERROR` and writes nothing.
- `cmdStop(root, ["--cancel"])` removes the marker and prints `scheduled stop cancelled`. A second call prints `no stop scheduled`. `--in` together with `--cancel` fails before writing anything.
- `tumwater stop --in xyz` and `tumwater stop --in 91d` fail at the flag gate, with the same wording shape as `wake --in`. `wake --in`'s existing tests pass unchanged.
- `armScheduledStopWatch`, run against a marker whose `until` has passed, calls `onStop` exactly once and removes the marker. Against a future `until` it does not call `onStop`.
- With a running fleet whose info has no `stopsAt` and a stop marker 30 minutes ahead, the status snapshot's `runStopsAt` equals the marker's `until`. When both are present, `runStopsAt` is the earlier one. With no running fleet, `runStopsAt` is absent.
- Existing `cmdStop` tests and `test/cli-run-window.test.ts` pass unchanged.


### A `run --for` fleet shows when it stops: `tumwater status`, the TUI header, and the dashboard sidebar carry a `stops in <duration>` countdown (planned 2026-10-12 by plan; follows the landed "`tumwater run --for` keeps one window across self-redeploys" plan; independent of the refused "Operator backlog writes land on main" part 2/2 — it touches no `src/backlog` file) (done 2026-10-12)

**Goal.** A fleet started with `tumwater run --for 8h` stops itself at a deadline that only the starting terminal knows: its banner prints `for 8h` once, and every observer (`tumwater status`, `status --json`, the TUI, the dashboard) shows it as a plain running fleet. An operator who checks in from another terminal cannot tell whether the fleet will still be running tonight. After this change, every observer shows the deadline while a windowed fleet runs, the way they show a timed pause's countdown.

**Approach.**
- **Publish.** Add `stopsAt?: number` (epoch ms) to `OrchestratorInfo` in `src/fleet/orchestrator-info.ts`, documented as the `run --for` window's deadline, absent for an unbounded run or a `--once` round. `normalizeInfoFields` drops it unless it is a finite number (the existing `isFiniteNumber` guard). Add `stopsAt?: number` to runOrchestrator's options interface in `src/orchestrator/orchestrator.ts` (beside `once`/`roleFilter`). runOrchestrator sets `info.stopsAt = opts.stopsAt` before its startup `writeOrchestratorInfo(root, info)` when the option is defined. `cmdRun` in `src/cli/cli-run.ts` passes `stopsAt: forMs !== null ? windowStart + forMs : undefined` in the same `runOrchestrator({ … })` call, so the value is the same inherited-window deadline `armDeadlineTimer` fires at; every generation after a self-redeploy publishes the same deadline.
- **Snapshot.** Add `runStopsAt?: number` to `StatusSnapshot` in `src/status/status-data.ts`, set like `disk`: `running && info?.stopsAt !== undefined ? info.stopsAt : undefined` (a stale info file beside a dead pid must not speak for a stopped fleet).
- **Badge.** Add `runWindowBadge(stopsAt: number | undefined, now: number): string` to `src/ui/badges.ts`: `` ` · stops in ${humanSeconds(secondsUntil(stopsAt, now))}` `` when `stopsAt > now`; ` · stopping` when `stopsAt <= now` (the drain after the deadline); `""` when undefined. `renderStatusSpans` in `src/ui/status-render.ts` places it right after the `running` spans (before the landing badge) with tone `"blue"`, through `badgeSpans`, so `tumwater status` and the TUI header (both render through `renderStatusSpans`) show it. An unwindowed fleet's header stays byte-identical (the badge is empty).
- **Payload and dashboard.** `statusPayload` in `src/ui/status-payload.ts` carries `runStopsAt` (only when defined, like `disk`) and a preformatted `runWindowBadge: runWindowBadge(snap.runStopsAt, now)`, so `status --json` and `GET /api/status` both expose it. `src/ui/gui/gui-client-fleet.ts`'s sidebar rows add, when `d.runWindowBadge` is non-empty, a blue `icon("info")` row labelled `badgeLabel(d.runWindowBadge)` (the disk row's pattern) with the detail "This run was started with `run --for`; at the deadline it drains in-flight work, prints a per-loop summary, and exits."
- **Unchanged.** The deadline timer, the summary, and the supervisor's env hand-off are untouched; this only publishes and renders a value cmdRun already computes.

**Files.** `src/fleet/orchestrator-info.ts`, `src/orchestrator/orchestrator.ts`, `src/cli/cli-run.ts`, `src/status/status-data.ts`, `src/ui/badges.ts`, `src/ui/status-render.ts`, `src/ui/status-payload.ts`, `src/ui/gui/gui-client-fleet.ts`; tests in `test/badges.test.ts`, `test/orchestrator-info.test.ts`, `test/status-render.test.ts`, `test/status-payload.test.ts`, `test/gui-client-fleet.test.ts`, `test/cli-run-window.test.ts`; README.md's `run --for` usage comment (add "shown as `stops in …` on status, the TUI, and the dashboard"); docs/how-it-works.md where it describes `run --for`, if it does.

**Acceptance criteria.**
- `runWindowBadge(undefined, now)` is `""`; `runWindowBadge(now + 2 * 3600_000, now)` is ` · stops in 2h`; `runWindowBadge(now - 1, now)` is ` · stopping`.
- `readOrchestratorInfo` keeps a numeric `stopsAt` and drops a string one, leaving the other fields intact.
- A rendered status header for a running snapshot with `runStopsAt` 90 minutes ahead contains `stops in 2h` (humanSeconds rounds 5400 s to the hour bucket) right after the `(pid …)` group; the same snapshot without `runStopsAt` renders exactly as it does today; a not-running snapshot never shows the badge.
- `statusPayload` carries `runStopsAt` and a non-empty `runWindowBadge` for a windowed snapshot, and neither key's value is set for an unwindowed one (`runWindowBadge` is `""`).
- The dashboard's fleet sidebar renders a `Stops in …` row (badgeLabel capitalizes the first letter) for a payload with `runWindowBadge`, and no such row without it.
- In test/cli-run-window.test.ts's "run --for boots, stops itself at the deadline, and prints the summary" test, polling `orchestratorStatePath(repo)` while the 3 s window runs (the file is removed at exit) finds a `stopsAt` within a few seconds of the spawn time plus 3000 ms.

### `tumwater run --for` keeps one window across self-redeploys: the deadline and the summary span every generation (done 2026-10-12; planned 2026-10-12 by plan; independent of the refused "Operator backlog writes land on main" part 2/2. It touches no `src/backlog`, `src/landing`, or orchestrator code. It builds on the landed "`run --for` ends with a per-loop summary" plan)

**Goal.** Today each orchestrator generation re-parses `--for` and arms a fresh deadline. `cmdRun`'s doc comment in `src/cli/cli-run.ts` calls this "the window is per-generation". So `tumwater run --for 2h` on a fleet that self-redeploys every hour never stops. Each generation's `windowSummary` also covers only its own ticks. After this change, the window opens once, when the supervisor starts. Every generation stops at that one deadline, and only the final exit prints the summary, covering the whole window.

**Approach.**
- **The mark.** Add `export const RUN_WINDOW_START_ENV = "TUMWATER_RUN_WINDOW_START"` to `src/process/supervisor.ts`, next to `SUPERVISOR_PID_ENV`, with a doc comment. Its value is the window's start as epoch ms. Give `spawnRunChild(signal, extraArgs = [], env: NodeJS.ProcessEnv = {})` a third parameter and spread it into the env it passes `spawnSupervised`, after `SUPERVISED_ENV` and `SUPERVISOR_PID_ENV`.
- **Supervisor side.** Pass `forMs` from `cmdRun` into `superviseRunCommand(root, args, branchArg, forMs)`. Before `superviseRun`, take `const windowStart = Date.now()` once. When `forMs !== null`, the `spawnChild` closure passes `{ [RUN_WINDOW_START_ENV]: String(windowStart) }`. Otherwise it passes `{}`. Every respawn reuses the closure, so every generation gets the same start.
- **Child side.** Add an exported pure helper `inheritedWindowStart(raw: string | undefined, now: number): number` in `src/cli/cli-run.ts`. It returns `Number(raw)` when that is a finite integer > 0 and ≤ `now`. Otherwise (absent, malformed, or in the future) it returns `now`. In `cmdRun`'s supervised half, compute `windowStart` this way, before the deadline timer. Arm `armDeadlineTimer(Math.max(0, windowStart + forMs - Date.now()), …)`. Move the existing `const windowStart = Date.now()` line next to `ticksBefore` up to this one computation. The `readTickRowsSince` call keeps using `windowStart`. A generation that boots after the deadline has passed arms 0 ms, stops at once, and prints the summary.
- **Summary only at the end.** In the `else if (forMs !== null)` branch, print `windowSummary` only when `!exit.restart`. A redeploying generation prints nothing of its own; the supervisor's "restarting on the new build" line already says what happened. The final generation's summary spans the whole window, because `windowStart` is inherited.
- **Unchanged.** The banner's `· for <label>` note, `windowSummary`'s output format, `--once`, the exit codes, and `parseRunWindow`.
- **Docs.** Rewrite the tail of `cmdRun`'s doc comment ("so the deadline restarts in the new generation — the window is per-generation…") and `windowSummary`'s doc comment ("A mid-window self-redeploy prints this before handing off…") to say what the code now does. In README.md, extend the `tumwater run --for 2h` usage comment with "(one window across self-redeploys)". In `src/cli/help.ts`, add the same phrase to the `--for <duration>` help lines.

**Files.** `src/process/supervisor.ts`, `src/cli/cli-run.ts`, `src/cli/help.ts`, README.md, `test/cli-run.test.ts`, `test/supervisor.test.ts`.

**Acceptance criteria.**
- test/cli-run.test.ts adds `inheritedWindowStart` cases: undefined → now; `"abc"` → now; `"0"` → now; a value greater than now → now; a valid past value → that value.
- test/supervisor.test.ts: `probeScript` also records `process.env[RUN_WINDOW_START_ENV]`. A new test shows `spawnRunChild(signal, [], { [RUN_WINDOW_START_ENV]: "123" })` hands the child `"123"` while `SUPERVISED_ENV` stays `"1"`. The existing `spawnRunChild runs the same script…` test still passes unchanged.
- test/cli-run-window.test.ts's `run --for boots, stops itself at the deadline, and prints the summary` passes unchanged. Its pre-window `ghost` tick is still excluded.
- `grep -n "per-generation" src/cli/cli-run.ts` finds nothing.
- `npm run test` passes.

### `tumwater run --for` ends with a per-loop summary of every tick in its window, not the once round's last-result line (done 2026-10-12; planned 2026-10-12 by plan; independent of the refused "Operator backlog writes land on main" part 2/2. It touches no `src/backlog`, `src/landing`, or orchestrator file. Today `cmdRun` in `src/cli/cli-run.ts` prints `onceSummary(...)` under `once || forMs !== null`. That line counts ticks from each role's `ticks` delta, but it buckets each role by its *last* result only. A two-hour window where `feature` ran 12 ticks prints `once: 12 ticks — 1 changed`, so the outcome counts do not add up to the tick count. The window's work is invisible, and the line is labelled `once:` for a run that was not one round. `test/cli-run.test.ts` already pins the mismatch for the once path: `"once: 5 ticks — 1 changed, 1 error, 1 no_change"`)

**Goal.** When a `run --for` generation exits, it prints a window line and then the `history --summary` table for the ticks that ended since that generation booted. Every tick counts once, by its outcome class. `--once` output does not change.

**Approach.**
- **Window start.** In `cmdRun`, record `const windowStart = Date.now()` just before `runOrchestrator` is awaited (beside the `ticksBefore` snapshot).
- **Rows.** After the orchestrator returns and `forMs !== null`, read `readTickRowsSince(root, windowStart, null)` from `src/history/history-data.ts`, then tally them with `summarizeTickRows`. That is the same pairing and `historyClass` rule `tumwater history --since … --summary` uses, so the two views cannot disagree.
- **Rendering.** Add an exported pure `windowSummary(label: string, summary: { loops: HistorySummaryRow[]; total: HistorySummaryRow }, covered: boolean): string` in `src/cli/cli-run.ts`.
  - First line: `for <label>: <plural(total.ticks, "tick")> — <changes> changes, <none> none, <problems> problems`. With zero ticks it reads `for <label>: 0 ticks — nothing ran`.
  - Then, when `total.ticks > 0`, the `history --summary` table. Get it by exporting `renderSummary` from `src/history/history.ts` unchanged; it is currently module-private.
  - When `covered` is false, append `SPARSE_WINDOW_NOTE` (from `src/events/event-window.ts`) as a last line.
  - `label` is `durationLabel(forMs)`, the same label the banner's `· for 3s` uses.
- **Wiring.** Change the call site to `if (once) say(onceSummary(...))` and `else if (forMs !== null) say(windowSummary(...))`. The `onceFailures` block stays under `once` only. `run --for` exit codes do not change.
- **Self-redeploy.** A mid-window self-redeploy still prints the summary before `process.exit(RESTART_EXIT_CODE)`, as today, and it covers that generation's ticks. The next generation restarts its deadline and its window start, which matches the existing `--for` hand-off documented on `cmdRun`. Note this in `windowSummary`'s doc comment.

**Files.** `src/cli/cli-run.ts`, `src/history/history.ts` (export `renderSummary`), `test/cli-run.test.ts`, `test/cli-run-window.test.ts`, README.md (the `tumwater run --for` usage comment: "… then drain, print a per-loop summary of the window, and exit"), `src/cli/help.ts` (the `--for` line, if it describes the exit output).

**Acceptance criteria.**
- New unit tests for `windowSummary` in test/cli-run.test.ts, built from `summarizeTickRows` over hand-made `TickRow` fixtures. Two `clean` rows (`changed`, `no_change`) and one `qa` row (`error`) render `for 2h: 3 ticks — 1 changes, 1 none, 1 problems`, then a `loop`/`ticks`/`changes`/`none`/`problems`/`last change` header and `clean`, `qa`, and `total` rows. An empty summary renders exactly `for 2h: 0 ticks — nothing ran`. `covered = false` appends `SPARSE_WINDOW_NOTE`.
- test/cli-run-window.test.ts's `run --for boots, stops itself at the deadline, and prints the summary` now asserts `/for 3s: \d+ ticks?/` and asserts that no line starts with `once:`.
- The existing `onceSummary` tests and test/cli-run-once.test.ts pass unchanged, so `--once` output stays the same.
- `tumwater history --summary` output is unchanged (its tests pass unchanged); the only edit there is the `export` keyword.

### `tumwater run --once` exits 3 when a role's round ended in a harness failure, so a cron or CI step can tell a broken round from a quiet one (planned 2026-10-12 by plan; independent of the refused "Operator backlog writes land on main" part 2/2 and of the waiting "`tumwater queue` marks the entries the landing pipeline is working on" plan. It touches no `src/backlog`, `src/landing`, or queue-render file. README and `help.ts` sell `--once` as "for cron/CI", but `cmdRun` in `src/cli/cli-run.ts` exits 0 after every round that does not request a restart. A round where every tick errored, the review gate could not parse a verdict, or main was red prints its `once: …` summary and still exits 0, so the CI job stays green) (done 2026-10-12)

**Goal.** After a `--once` round, the process exits 3 (`ONCE_FAILED_EXIT_CODE`) when at least one role that ticked this round ended with a failure result. It also prints one line naming those roles. A quiet round, a productive one, and one whose only bad news is a rejection or refusal still exit 0. The summary line itself does not change.

**Approach.**
1. In `src/cli/cli-run.ts`, add an exported `ONCE_FAILURE_RESULTS: ReadonlySet<TickResult>` with `error`, `review_error`, `merge_conflict`, `merge_blocked`, and `main_red`. Its doc comment states the rule: these mean the harness or the project's check failed and the round's work did not land. `rejected` and `refused` are deliberately excluded because they are the review gate and the agent working as designed. `aborted`, `quiet_killed`, and `user_aborted` are excluded too: a once round only sees them on a shutdown or an operator abort, which already has its own exit path (130). This is one opinionated set, not a knob.
2. Pull the per-role "ticks this round" computation out of `onceSummary` into a private helper, `ticksThisRound(s, role, ticksBefore, ticksRun?)`. It returns `ticksRun ? (ticksRun.get(role) ?? 0) : s.ticks - (ticksBefore.get(role) ?? 0)`, and `onceSummary` calls it in place of its inline expression. Output stays byte-for-byte the same, so the existing `test/cli-run.test.ts` `onceSummary` tests pass unedited.
3. Add an exported `onceFailures(root, roles, ticksBefore, ticksRun?): { role: string; result: TickResult }[]`. It walks `[...roles, ...extra]`, using the same `extra` rule as `onceSummary` (roles that appear only in `ticksRun`). It loads each role's state with `loadLoopState` and keeps the roles where `ticksThisRound(…) > 0` and `ONCE_FAILURE_RESULTS.has(s.lastResult)`. By the time the round exits, `exitReady` has required an empty land queue and no landing in flight. So a queued tick's `lastResult` already holds its landing's outcome, which `applyLandingOutcome` in `src/tick/tick-apply.ts` writes.
4. **The exit code must not read as a crash.** `tumwater run` executes the round in a supervised child (`superviseRunCommand` → `superviseRun` in `src/process/supervisor.ts`). The supervisor calls `fleetDown`, which logs a `supervisor_exit` event and pages the notify hook as "fleet down", for any nonzero child exit that is not `RESTART_EXIT_CODE` while not stopping. So a plain exit 1 would page the operator on every failed CI round. In `src/process/supervisor.ts`, export `ONCE_FAILED_EXIT_CODE = 3`, with a doc comment: a once round that finished and found failures, an asked-for ending. Then change `superviseRun`'s asked-for test so that `exit.code === ONCE_FAILED_EXIT_CODE` skips `fleetDown` just as code 0 does, and the code is still returned unchanged. A grep of `src` today finds no other use of exit code 3.
5. In `cmdRun`, inside the existing `if (once || forMs !== null)` block, after `say(onceSummary(…))` and only when `once` is set, compute `onceFailures(root, roles, ticksBefore, exit.ticksRun)`. When it is non-empty, print `once: failed — <role> <result>, <role> <result>` with `say` (stdout, beside the summary, so a cron log keeps both) and set `process.exitCode = ONCE_FAILED_EXIT_CODE`. Read it from the `supervisor.js` dynamic import `cmdRun` already does (add it to that destructure). Use `exitCode`, not `process.exit`, so the following `exit.restart` check and normal teardown run unchanged. This is the same idiom `doctor` uses in `src/cli.ts`. `src/cli.ts` never calls `process.exit` on the success path, so the child exits with that code and the supervisor passes it through as its own exit. A `--for` windowed run keeps exit 0: it runs many ticks per role, and the last result alone does not describe the window.
6. Docs: in `src/cli/help.ts`, change the `run` stanza's `--once` lines to say the round exits 3 when a tick ended in error, review_error, merge_conflict, merge_blocked, or main_red. In README.md's Usage block, the `tumwater run --once` comment gains "exits 3 if a loop's tick failed". Add one sentence to the `tumwater run --once` paragraph of `docs/how-it-works.md`. Today no test pins the stanza's `for cron/CI` wording (grep over `test/`).

**Files touched.** `src/cli/cli-run.ts`, `src/process/supervisor.ts`, `src/cli/help.ts`, README.md (Usage block only, outside the tumwater:prompt markers), `docs/how-it-works.md`, `test/cli-run.test.ts`, `test/cli-run-once.test.ts`, `test/supervisor.test.ts`, `docs/invariants.md` (INV-E2, "a fleet that goes down unasked runs the configured notify hook once": add one sentence that a once round's `ONCE_FAILED_EXIT_CODE` is an asked-for ending, pinned by the new supervisor test).

**Acceptance criteria.**
- `test/cli-run.test.ts`: `onceFailures` returns `[{ role: "clean", result: "error" }]` for a role with `lastResult: "error"` that ticked this round (ticks-run map `clean → 1`). It returns `[]` when that same role did not tick this round (ticks-run `0`), for `lastResult` `rejected`, `refused`, and `no_change`, and for `changed`. Each member of `ONCE_FAILURE_RESULTS` is reported. A role present only in the ticks-run map is checked too.
- The existing `onceSummary` tests in `test/cli-run.test.ts` pass without edits.
- `test/cli-run-once.test.ts`: the existing "exits 0" test passes unchanged. A new test runs `run --once --role clean` under a fake pi that fails every run (`withPi` with a script that exits nonzero). It first asserts that `loadLoopState(repo, "clean").lastResult` is `"error"`, adjusting the script until it is, and then that the exit code is 3 and stdout matches `/once: failed — clean error/`.
- Supervisor test: a child exiting `ONCE_FAILED_EXIT_CODE` makes `superviseRun` return 3 without calling `onFleetDown`. The existing tests, including "a generation that dies unasked is reported through onFleetDown" with its exit code, pass unchanged.
- `run --for` exit behavior is unchanged: grep shows that `onceFailures` is called only under `once`.
- `npm run test` passes.

### `tumwater queue` marks the entries the landing pipeline is working on right now (done 2026-10-12; planned 2026-10-12 by plan; independent of the refused "Operator backlog writes land on main" part 2/2 above — it touches no `src/backlog` file. The queue view lists every waiting landing with its age, but it does not say which entries a vet or the merge holds right now, or which stage each is in. Only the per-loop rows in `status`, the TUI, and the dashboard show that (`loopPhase`'s `landing 2m · reviewing` / `vetted, awaiting merge`). So an operator reading `tumwater queue` cannot tell a stuck head from one that is being reviewed)

**Goal.** Each queue line whose change has a live record in the in-flight landing marker ends its metadata with a bracketed label in the same wording the loop rows use. The three queue surfaces get it together: `tumwater queue`, the TUI Pending pane (it renders through the same `renderLandingQueue`), and the dashboard's Land queue card (`pendingQueueHtml`). Their shared-wording claim stays true. Example: `  1. feature tick #3 · abc1234 · 5m ago · [landing 2m · reviewing] · Add X`, or `[vetted, awaiting merge]`. An entry with no record, or a `done` record, keeps today's line byte for byte.

**Approach.**
1. Move the private `LANDING_STAGE_LABELS` map from `src/ui/status-model.ts` to `src/landing/landing-slot.ts`, next to `LandingStage`. Export it, and import it back in `status-model.ts` so `loopPhase` keeps its output.
2. In `src/landing/landing-queue-render.ts`, add an exported pure `queueEntryLandingLabel(sha: string, inFlight: LandingInFlight | undefined, now: number): string`. It looks up the record in `landingChanges(inFlight)` by `sha` (queue entries are keyed by pinned sha; the marker keeps one record per role and per sha). It returns:
   - `""` when there is no marker, no record, or `status === "done"`;
   - `"vetted, awaiting merge"` for `vetted`;
   - otherwise `landing`, then ` <humanSeconds(secondsSince(startedAt, now))>` when `startedAt` is set, then ` · <LANDING_STAGE_LABELS[stage]>` when `stage` is set.
   The elapsed time uses the same `humanSeconds` the age column uses, so the line stays a pure function of `now`. `renderLandingQueue(view, now, inFlight?)` gains an optional third parameter and inserts ` · [<label>]` between the age and the summary when the label is non-empty.
3. In `src/status/status-polls.ts`, add `queueInFlight(root: string, entries: LandingEntry[], running: boolean): LandingInFlight | undefined`. It returns `running ? liveLandingMarker(readLandingMarker(root), shas)` (undefined when the marker is null). This puts the cross-check in one place. Replace `snapshot`'s inline `running && landingMarker ? liveLandingMarker(…)` in `src/status/status-data.ts` with a call to it, with unchanged behavior.
4. `cmdQueue` (`src/cli/cli-query-commands.ts`): read the view once, compute `queueInFlight(root, view.entries, orchestratorAlive(root))`, and pass it to `renderLandingQueue`. The `--json` document becomes `{ ...view, inFlight }`, with the key present only when it is defined. That matches `status --json`'s `landQueue.inFlight` shape, so the two cannot disagree. A stopped fleet or a stale marker therefore prints exactly today's output.
5. The TUI Pending pane (the `renderLandingQueue(readLandingQueue(root), now())` call in `src/ui/tui/tui-keys.ts`) passes the same `queueInFlight(root, view.entries, orchestratorAlive(root))`.
6. The dashboard: `statusPayload` (`src/ui/status-payload.ts`) adds a display-ready `landQueueLabels: string[]`, parallel to `snap.landQueue.entries ?? []`, built with `queueEntryLandingLabel(e.sha, snap.landQueue.inFlight, now)`. This follows the `landingBadge` precedent: browser JS cannot import the TypeScript labels. `pendingQueueHtml(landQueue, now, labels)` in `src/ui/gui/gui-client-pending.ts` inserts ` · [<esc(label)>]` before the summary when `labels[i]` is a non-empty string. `renderPendingQueue` passes `status.landQueueLabels`. A missing or non-array `labels` renders today's rows.
7. Docs: the `queue` line in `src/cli/help.ts` and the README "Check state" row's `tumwater queue` text mention the label. If `docs/how-it-works.md` describes the queue line's fields (around its `renderLandingQueue` mention), it gets one sentence too.

**Files touched.** `src/landing/landing-slot.ts`, `src/ui/status-model.ts`, `src/landing/landing-queue-render.ts`, `src/status/status-polls.ts`, `src/status/status-data.ts`, `src/cli/cli-query-commands.ts`, `src/ui/tui/tui-keys.ts`, `src/ui/status-payload.ts`, `src/ui/gui/gui-client-pending.ts`, `src/cli/help.ts`, README.md, plus tests in `test/landing-queue.test.ts` and `test/gui-client-pending.test.ts`.

**Acceptance criteria.**
- `test/landing-queue.test.ts`: `renderLandingQueue(view, now, inFlight)`, given a marker with one `landing` record (`startedAt = now - 120_000`, `stage: "reviewing"`) and one `vetted` record whose shas match entries 1 and 2, prints `· [landing 2m · reviewing] ·` on line 1 and `· [vetted, awaiting merge] ·` on line 2, and leaves a third entry's line unchanged. A `done` record, a record whose sha is not queued, and an `inFlight` of `undefined` each produce exactly the same text as the two-argument call. A record with no stage prints `[landing 2m]`.
- `queueEntryLandingLabel` reads an older-generation marker with no `changes` array as one `landing` record (through `landingChanges`).
- `test/gui-client-pending.test.ts`: `pendingQueueHtml` with `labels` puts `[landing 2m · reviewing]` in the matching row, escapes a label's markup, and with `labels` absent renders today's rows (the existing pendingQueueHtml tests pass unchanged).
- `loopPhase` output is unchanged: the existing status-model tests pass without edits.
- `tumwater queue` and `tumwater queue --json` print exactly today's output when no orchestrator is alive, even with a marker file present. `test/cli-queue.test.ts` gains this case, and its existing cases and the TUI Pending pane tests in `test/tui-keys.test.ts` pass unchanged (`test/help.test.ts` is updated only if it pins the `queue` help line).
- `npm run test` passes.

### `tumwater history --summary` names when each loop last produced a change: a `last change` column and `lastChangeTs` in the JSON (done 2026-10-12; planned 2026-10-12 by plan; extends the Done "`tumwater history --summary` tallies each loop's tick outcomes" entry; independent of the refused "Operator backlog writes land on main" part 2/2 above)

**Goal.** `history --summary` counts each loop's changes, but it does not say *when* the newest one happened. A loop showing `changes 1` over `--since 7d` may have landed an hour ago or six days ago. No surface says when a loop last landed: `LoopState` (src/loop/loop-state.ts) keeps only `lastResult`/`lastTickEndedAt`, and `status` shows the last tick, not the last change. Add the timestamp of each loop's newest changes-class row to the summary.

**Approach.**
- **Collector.** In `src/history/history-data.ts`, give `HistorySummaryRow` a field `lastChangeTs: number | null`.
  - `summarizeTickRows`'s `blank` starts it at `null`.
  - For each row where `historyClass(row.result) === "changes"`, set the loop entry's and `total`'s `lastChangeTs` to the larger of the current value and `row.ts`. Take the max, never the last row seen: row order is newest first, and a pure function must not depend on that.
  - Update the doc comment to say `lastChangeTs` is the newest changes-class row's `ts`, or `null` when the loop had none among the rows.
- **Text form.** In `renderSummary` (`src/history/history.ts`), append a fifth column `last change` after `problems`, separated by the same two spaces.
  - The cell is `formatTimestamp(r.lastChangeTs)` from `src/text/datetime.ts` (the same formatter that makes `TickRow.time`), or `—` when the value is `null`.
  - The column is left-aligned and is the last one, so it needs no padding; the existing `trimEnd` still applies.
  - The four numeric columns keep their current right-alignment rule.
  - Extend the doc comment to name the new column.
- **JSON.** `--summary --json` prints `summarizeTickRows(rows)` as today, so every `loops` entry and `total` now carry `lastChangeTs`. No other change is needed.
- **Docs.**
  - In the history stanza of `src/cli/help.ts`, change "counting its ticks by outcome class (and a total line)" to "counting its ticks by outcome class, with the time of its newest change (and a total line)".
  - Make the same wording change in README.md's "Watch per-tick history" row ("…counting its ticks by outcome class and naming its newest change (plus a total)…").

**Files.** `src/history/history-data.ts`, `src/history/history.ts`, `src/cli/help.ts`, README.md, test/history-data.test.ts, test/cli-history-filtering.test.ts. No test asserts the help wording that changes (`grep -rn "outcome class" test` matches no help text), and docs/invariants.md has no history-summary entry.

**Acceptance criteria.**
- **Unit tests** in test/history-data.test.ts, "summarizeTickRows tallies each loop's outcome classes in name order with a total":
  - Give the rows distinct `ts` values. The test asserts each loop's `lastChangeTs` is the largest `ts` among its `changed`/`queued` rows (bugfix's `queued` counts as a change).
  - It asserts `total.lastChangeTs` is the largest of those.
  - The empty-input case deep-equals `{ loops: [], total: { loop: "total", ticks: 0, changes: 0, none: 0, problems: 0, lastChangeTs: null } }`.
  - Add a case where a loop's only change is *older* than one of its no-change rows, to prove the max is taken over changes-class rows only.
- **CLI text form.** In test/cli-history-filtering.test.ts, "history --summary tallies each loop's outcomes…" runs on `seededHistoryRepo()` (feature #7 `changed` at ts 1787222695956, clean #3 `no_change`, bugfix #9 `error`).
  - It asserts the exact trimmed lines. The header gains `  last change`, the bugfix and clean lines end in `  —`, and the feature and total lines end in `  ` + `formatTimestamp(1787222695956)`.
  - The test imports `formatTimestamp` from `../src/text/datetime.js` to build the expected text, so it passes in any time zone.
- **CLI JSON.** In the same test, `payload.total` deep-equals `{ loop: "total", ticks: 3, changes: 1, none: 1, problems: 1, lastChangeTs: 1787222695956 }`. `history --summary --result problems` shows `—` on its total line.
- **Unchanged output.** Without `--summary`, `history`'s output is unchanged, and "history --summary keeps the empty-state output on an empty log" passes unmodified.
- **Check.** `npm run test` passes.


### `tumwater history --summary` tallies each loop's tick outcomes (ticks, changes, none, problems) over the same rows the table would print (planned 2026-10-12 by plan; independent of the refused "Operator backlog writes land on main" part 2/2 above) — done 2026-10-12

**Goal.** Make it easy to see which loops are producing work, idling, or failing. Today an operator has to count rows by eye in `tumwater history --since 24h`. `tumwater report` counts ticks and commits per role, and `report --failures` lists failures, but nothing tallies outcome classes per loop. `history --summary` swaps the row table for one line per loop: its tick count split into the three `HISTORY_RESULT_CLASSES` buckets (`historyClass` in `src/history/history-data.ts`). It reads the same rows the table would print, so it composes with `--role`, `-n`, `--since`, `--grep`, `--result`, and `--json` with no new rival-shape rule.

**Approach.**
- **Collector.** In `src/history/history-data.ts`, add an exported `HistorySummaryRow` (`{ loop: string; ticks: number; changes: number; none: number; problems: number }`) and a pure `summarizeTickRows(rows: TickRow[]): { loops: HistorySummaryRow[]; total: HistorySummaryRow }`:
  - It counts each row once under `historyClass(row.result)`.
  - `loops` is sorted by loop name with plain string comparison (`a < b`), not `localeCompare`, so the order is deterministic.
  - `total` has `loop: "total"` and sums every loop.
  - An empty input gives `loops: []` and an all-zero total.
- **Flag spec.** In `src/cli/cli-flag-specs.ts`, add `SUMMARY_FLAG: FlagSpec = { names: ["--summary"] }`, value-less like `STAT_FLAG`. Add it to the `history` case's `rejectUnknownArgs` list in `src/cli.ts`.
- **Command.** In `cmdHistory` (`src/history/history.ts`), read `rest.includes("--summary")` after the `--result` filter. Every filter has already run at that point, and the empty-state prose branch is unchanged: an empty row set prints the same `no ticks yet` / `no ticks in …` / `no ticks matching …` / `no ticks with result …` line, and with `--json` the same `{"rows":[]}`. With rows present:
  - **`--json`.** Print `sayJson(summarizeTickRows(rows))`, i.e. `{ loops, total }`, in place of `{ rows }`.
  - **Text.** Print a new local `renderSummary`:
    - A header line `loop  ticks  changes  none  problems`, one line per loop, then the `total` line, which is always printed.
    - Columns are joined by two spaces, and each line is `trimEnd`ed.
    - The loop column is padded with `padToWidth` to the widest `displayWidth` among `"loop"`, `"total"`, and the loop names.
    - Each numeric column is `padStart`ed to the larger of its header's length and its widest value, so numbers right-align under their header.
  - **Sparse note.** The `!covered` `SPARSE_WINDOW_NOTE` line still follows the text form, and never the JSON form, as it does today.
- **Docs.** `src/cli/help.ts`'s history stanza gains `[--summary]` on its usage line plus one sentence: "--summary prints one line per loop counting its ticks by outcome class (and a total line) instead of the rows; with --json, `{ loops, total }`". README.md's "Watch per-tick history" row gets the same mention.

**Files.** `src/history/history-data.ts`, `src/history/history.ts`, `src/cli/cli-flag-specs.ts`, `src/cli.ts`, `src/cli/help.ts`, README.md, test/history-data.test.ts, test/cli-history.test.ts.

**Acceptance criteria.**
- **Unit tests** in test/history-data.test.ts:
  - `summarizeTickRows` over rows with results `changed`, `queued`, `no_change`, `skipped`, `error`, and `rejected`, spread across two loops, gives each loop's `changes`/`none`/`problems` per `historyClass`.
  - Loops come back in name order, and the total sums them.
  - An empty input gives `{ loops: [], total: { loop: "total", ticks: 0, changes: 0, none: 0, problems: 0 } }`.
- **CLI text form.** On `seededHistoryRepo()` (bugfix #9 error, clean #3 no_change, feature #7 changed), `tumwater history --summary` exits 0 and prints exactly these lines, after trimming each line's end:
  `loop     ticks  changes  none  problems` / `bugfix       1        0     0         1` / `clean        1        0     1         0` / `feature      1        1     0         0` / `total        3        1     1         1`.
  The implementer derives the exact padding from the rule above (loop column width 7 = `feature`) and asserts it.
- **CLI JSON and filters.**
  - `tumwater history --summary --json` parses to `{ loops: [...three entries...], total: { loop: "total", ticks: 3, changes: 1, none: 1, problems: 1 } }`.
  - `history --summary --role feature` prints only the header, the `feature` line, and the total line.
  - `history --summary --result problems` counts only bugfix's tick.
- **Edges.** On an empty log, `history --summary` prints `no ticks yet`, and `history --summary --json` prints `{"rows":[]}`.
- **Unchanged output.** Without `--summary`, `history`'s output is unchanged: the existing tests in test/cli-history.test.ts and test/cli-history-filtering.test.ts pass unmodified, apart from the help-stanza regex in "history rejects unknown flags…", which is updated for the new `[--summary]` usage token.
- **Check.** `npm run test` passes.

### The TUI's History tick trail (Ctrl+N) ends with the tick commit's per-file stat, matching `tumwater tick <role> <n> --stat` and the dashboard drill-down (planned 2026-10-12 by plan; independent of the refused "Operator backlog writes land on main" part 2/2 above. TUI sibling of the Done "dashboard's History drill-down shows the tick commit's per-file stat" plan, done 2026-10-12)

**Goal.** `tumwater tick … --stat` and the dashboard's History drill-down (`GET /api/tick`'s `stat`) both show which files a tick's pinned commit changed. The TUI's History-pane trail (Ctrl+N in `createTuiKeys`, `src/ui/tui/tui-keys.ts`) shows only `renderTickDetail` text. Append the same stat text so all three surfaces agree.

**Approach.**
- **Seam.** Add `tickStat?(root: string, detail: TickDetail): Promise<string>` to `createTuiKeys`'s deps, next to `collectChange`; default `tickDetailStat` from `src/tick/tick-detail.ts` (already exported and async, it owns the "(no commit: …)" / "(commit … is not in this repository)" texts). `TickDetail` imports from `src/tick/tick-detail-data.ts`.
- **Load.** The trail stays sync-first: Ctrl+N entry and `refreshTrail` keep setting `trailCache = renderTickDetail(detail)` at once, then fire `void tickStat(root, detail).then(…)`. On resolve, set ``trailCache = `${text}\n\n${stat}` `` — the exact join `cmdTick` uses for `--stat` — and call `deps.requestRender()`. A rejection flashes via `flashError` and leaves the trail text as is.
- **Staleness.** Add a module-local `trailGen` counter in `createTuiKeys`, bumped at every trail read or reset (Ctrl+N entry, Ctrl+N exit, `refreshTrail`, the Ctrl+T cycle-away reset) but not by the stat's own resolution. A resolution applies only when `trailMode` is still on and its captured gen equals `trailGen`, so leaving the trail, cycling away, or a Ctrl+G/roster re-read cannot be overwritten by an older tick's stat (the `collectChange` guard's pattern).
- **Unchanged.** `renderTickDetail`, `tickDetailStat`, `cmdTick`, `/api/tick`, and `src/ui/tui/tui-pane.ts` (it already windows whatever `trailCache` holds). Scroll stays where it is when the stat arrives.

**Files.** `src/ui/tui/tui-keys.ts`, `test/tui-keys.test.ts`, `docs/how-it-works.md` (the History pane's `Ctrl+N` sentence names the stat footer and `tumwater tick --stat`).

**Acceptance criteria.**
- New test in test/tui-keys.test.ts: with a `tickStat` seam returning a controlled promise, Ctrl+N on History sets `trailCache` to `renderTickDetail(...)` immediately; after the promise resolves to `" a.ts | 1 +"`, `trailCache` equals `renderTickDetail(...) + "\n\n a.ts | 1 +"` and a render was requested.
- New test: Ctrl+N twice (exit) before the stat resolves leaves `trailCache` null after resolution; and a Ctrl+G re-read before resolution is not overwritten by the first tick's stat.
- New test: a rejecting `tickStat` leaves `trailMode` on with the plain trail text and sets the flash.
- The existing "Ctrl+N on the History pane swaps the rows for the newest completed tick's trail", Ctrl+G, and roster-change trail tests pass unchanged.

### The dashboard's History drill-down shows the tick commit's per-file stat, matching `tumwater tick <role> <n> --stat` (planned 2026-10-12 by plan; independent of the refused "Operator backlog writes land on main" part 2/2 above. Dashboard sibling of the landed `tick --stat` plan (in Done). A TUI sibling is not planned yet: the TUI trail is computed synchronously in `createTuiKeys`, and `tickCommitStat` is async; done 2026-10-12)

**Goal.** `tumwater tick <role> <n> --stat` ends a tick's trail with its pinned commit's `git show --stat` summary. The dashboard's History drill-down card (fed by `GET /api/tick`) shows only the trail, so an operator in the browser can see that a tick changed something but not which files. `/api/tick` should carry the same stat text, and the card should show it under the trail.

**Approach.**
- **Shared helper.** In `src/tick/tick-detail.ts`, export one new `tickDetailStat(root: string, d: TickDetail): Promise<string>` that returns `tickCommitStat(root, tickCommitSha(d))`. `tickCommitSha` and `tickCommitStat` stay module-local. `cmdTick`'s `--stat` branch calls `tickDetailStat`, so the CLI and the endpoint share one rule (the sha, the "(no commit: …)" text, and the "(commit … is not in this repository)" text).
- **Endpoint.** `handleTick` in `src/gui/gui-endpoints.ts` becomes `async` (returns `Promise<void>`, as `handleDiff` does; the `"GET /api/tick"` route in `src/gui/gui-server.ts` needs no change because `RouteHandler` already admits async handlers). It always computes the stat. There is no query flag (opinionated default): a drill-down is one request on click, and the cost is one `git show --stat`. The 200 payload becomes `{ ...detail, text: renderTickDetail(detail), stat: await tickDetailStat(root, detail) }`. `text` stays exactly as today. The 400 and 404 paths are unchanged and compute no stat.
- **Client.** In `src/ui/gui/gui-client-history.ts` (the `history-detail` region), `fetchHistDetail` stores `stat: typeof d.stat === "string" ? d.stat : ""` in the ok cache entry. An older server that sends no `stat` is not an error. `histDetailCardHtml` appends `"<pre class='mono hist-detail-stat'>" + esc(entry.stat) + "</pre>"` after the trail (or after the "No events" placeholder) when `entry.stat` is non-empty. The existing `.hist-detail pre` rule in `src/ui/gui/gui-styles.ts` already styles it, so no CSS change is needed.
- **Docs.** None. As of planning, neither README.md nor docs/how-it-works.md describes the dashboard's History drill-down card (`grep -n drill` finds only the TUI's), so neither needs a clause.

**Files.** `src/tick/tick-detail.ts`, `src/gui/gui-endpoints.ts`, `src/ui/gui/gui-client-history.ts`, test/gui-endpoints.test.ts, test/gui-server-api.test.ts, test/gui-client-history.test.ts, test/tick-detail.test.ts (only if a `--stat` assertion needs the shared helper).

**Acceptance criteria.**
- test/gui-endpoints.test.ts "handleTick serves one tick's collector payload plus its pre-rendered text" is updated to `await` the handler and to assert `data` deep-equals `{ ...detail, text: renderTickDetail(detail), stat: "(no commit: this tick queued no landing)" }`. That fixture has no `land_queued` event.
- A new handleTick test seeds a `land_queued` event whose `commit` is a sha that is not in the (non-git) temp dir and asserts that `stat` matches `/^\(commit [0-9a-f]+ is not in this repository\)$/`.
- The handleTick error-cases test still passes: 400 for a missing or unknown role and for a bad tick, 404 for a missed tick, and no `stat` key on any error body.
- test/gui-client-history.test.ts: with `getJson` answering `{ text: "…", stat: " a.ts | 2 +-" }`, the open card contains `hist-detail-stat` and `a.ts | 2 +-`. With the answer lacking `stat`, the card has no `hist-detail-stat` and the entry's state is still `ok`.
- The existing `tumwater tick --stat` tests in test/tick-detail.test.ts pass unchanged.
- `npm run test` passes.

### `tumwater tick` resolves a queued tick to its landing verdict, as `tumwater history` already does, and ends the trail with the landing's outcome line (planned 2026-10-12 by plan; independent of the refused "Operator backlog writes land on main" part 2/2 above. Shares `src/tick/tick-detail.ts` and `test/tick-detail.test.ts` with the landed `tick --stat` plan (now in Done), but not behavior: `renderTickDetail` now takes its header sha from `tickCommitSha`, and the landing line appends after the trail, before any `--stat` text) (done 2026-10-12)

**Goal.** A changed tick ends `queued`: its `tick_end` is logged before the landing slot vets and merges the pinned commit, and the slot's later `landed`/`land_failed` event falls outside the tick's block. `tickRows` in `src/history/history-data.ts` already joins each queued row to that verdict through `bucketLandingEvents` + `resolveQueuedResult`, so `tumwater history` says `changed` or `rejected`. `readTickDetail` in `src/tick/tick-detail-data.ts` uses the raw `outcomeText(end)`, so `tumwater tick` says `queued` about the same tick, forever. The two surfaces disagree, and the drill-down meant to explain a tick cannot tell the operator whether its work reached main. `renderTickDetail` feeds the CLI, the TUI History drill-down (`src/ui/tui/tui-keys.ts`) and `GET /api/tick` (`src/gui/gui-endpoints.ts`), so one collector change fixes all three.

**Approach.**
- `src/tick/tick-detail-data.ts`: add `landing: HarnessEvent | null` to `TickDetail`, documented as the resolved landing outcome event (`landed` or `land_failed`) for a queued tick, null otherwise. In `detailFrom`, when `end !== null` and `outcomeText(end) === "queued"`, call `bucketLandingEvents(scoped)` and `resolveQueuedResult(end, landQueuedByLoop, outcomeByLoop, new Map(), tickStartMap(scoped), null)` (both exported from `src/history/history-data.ts`; `scoped` is already the role-filtered whole scan, so it holds pins and outcomes logged after the block). A fresh claim cursor is right for one tick: the walk starts from the newest pin at or before `end.ts`, which is this tick's own pin, because later ticks' pins sit after its end. On a hit, `result` becomes `resolved.result` and `landing` becomes `resolved.outcome`. On null (landing still pending, or its outcome rotated out), `result` stays `"queued"` and `landing` is null. Every other result, and an in-flight or unpaired block, keeps today's values with `landing: null`.
- `src/tick/tick-detail.ts`: `renderTickDetail` appends `formatEvent(d.landing)` as the last line when `landing` is non-null. It comes after the block's events, which is also its chronological place. The header already shows `d.result`, so it reads the resolved verdict with no further change. Update the doc comment to say so.
- `src/cli/help.ts` (`tumwater tick` stanza) and README.md's "Watch per-tick history" row: one clause each saying a queued tick shows its landing's verdict and outcome line once the landing finishes.

**Files.** `src/tick/tick-detail-data.ts`, `src/tick/tick-detail.ts`, `src/cli/help.ts`, README.md, `test/tick-detail-data.test.ts`, `test/tick-detail.test.ts`. docs/invariants.md has no tick-detail section (checked with `grep -n -i "readTickDetail\|tumwater tick" docs/invariants.md`), so it is not touched.

**Acceptance criteria.**
- test/tick-detail-data.test.ts, new test: seed `tick_start` (tick 1), `land_queued` sha1, `tick_end` result `queued`, then `landed` sha1 result `changed`, then tick 2 with `land_queued` sha2, `tick_end` `queued`, and `land_failed` sha2 result `rejected`. `readTickDetail(root, "feature", 1)` has `result === "changed"` and `landing.type === "landed"`. Tick 2 has `result === "rejected"` and `landing.type === "land_failed"`. Neither block's `events` contains the outcome event.
- A queued tick whose landing has not finished (no outcome event) reads `result === "queued"`, `landing === null`.
- A `changed` (non-queued) tick has `landing === null` and its result is unchanged.
- test/tick-detail.test.ts: `renderTickDetail` over the resolved tick 1 has a header matching `/tick #1 — changed/`, and its last line matches `/landing of sha1 complete/` (match whatever `shortSha` yields). Over a non-queued tick it prints the same line count as before.
- `cmdTick --json` on the resolved tick parses with a `landing` object. The existing test "renderTickDetail prints the summary header, the commit sha, and formatEvent lines" passes unedited, as does every existing test in test/tick-detail.test.ts, test/tick-detail-data.test.ts, and test/history-data.test.ts.

### `tumwater tick <role> [<n>] --stat` appends the tick's commit's per-file `git show --stat` summary to its event trail (planned 2026-10-12 by plan; sibling of the landed `tumwater diff --role <id> --stat`; independent of the refused "Operator backlog writes land on main" part 2/2 above, and touches none of its files) (done 2026-10-12)

**Goal.** `tumwater tick <role> <n>` prints a tick's event trail and names its pinned commit (`· commit <short sha>` in the header), but it can't say what that commit changed. Today an operator reviewing a past tick copies the sha into `git show --stat` by hand. `tumwater diff --role <id> --stat` answers the same question for a loop's *pending* work, but nothing answers it for a *finished* tick. After this change, `--stat` appends the commit's per-file summary below the trail.

**Approach.**
- **One commit rule.** In `src/tick/tick-detail.ts`, export `tickCommitSha(d: TickDetail): string | null`. It returns the `commit` of the first event in `d.events` whose type is `land_queued` or `landed` and whose `commit` is a non-empty string, else null. It is the predicate `renderTickDetail` uses inline today. `renderTickDetail` calls it, so the header's sha and the stat's sha can't differ. The header text does not change.
- **Stat text.** Add `async function tickCommitStat(root: string, sha: string | null): Promise<string>` to the same file:
  - With `sha === null`, it returns `(no commit: this tick queued no landing)`.
  - Otherwise it runs `gitTry(root, "show", "--stat", "--format=", sha)` (from `src/git/git-run.ts`) and returns the output with `trimEnd()` applied. Checked against this repo: with `--format=`, the output starts directly at the first ` path | N +-` line, with no header or leading blank line.
  - On `null` (git exit 128: the object is gone or the sha is foreign), it returns `(commit <shortSha(sha)> is not in this repository)`.
  - The sha is the authored commit the tick pinned. A landing that rebased gives main a different sha with the same changes, so the stat describes what the tick changed. Say so in the doc comment.
- **Flag.** Add `--stat` to the `cmdTick` signature as a fifth parameter, `stat = false`. In `src/cli.ts`'s `tick` case, add `STAT_FLAG` (already exported from `src/cli/cli-flag-specs.ts`) to `rejectUnknownArgs("tick", rest, [JSON_FLAG, LAST_FLAG, STAT_FLAG])`, and pass `rest.includes("--stat")`.
- **cmdTick behavior with `stat`.**
  - **Text form.** Print `renderTickDetail(detail)`, a blank line, then the stat text.
  - **JSON form.** Print `{ ...detail, stat: <the same string> }`. Without `--stat`, the payload is unchanged (no `stat` key).
  - **Not found.** Unchanged: the line, or `null` under `--json`, with no git call.
- **Usage.** `TICK_USAGE` becomes `tumwater tick <role> [<n>] [--last] [--stat] [--json]`. Update the same usage in `src/cli/help.ts`, and add to its description: "--stat appends the pinned commit's per-file `git show --stat` summary". Update the `cmdTick` doc comment's usage line too.
- **Other surfaces.** The GUI's `/api/tick` and the TUI History drill-down call `readTickDetail`/`renderTickDetail` and do not change.

**Files.** `src/tick/tick-detail.ts`, `src/cli.ts`, `src/cli/help.ts`, README.md (the "Watch per-tick history" row's `tumwater tick` clause gains "`--stat` appends the tick's commit's per-file `git show --stat` summary"), test/tick-detail.test.ts.

**Acceptance criteria.**
- New test in test/tick-detail.test.ts:
  - **Setup.** After `initProject` on a `makeRepo()` repo, read `HEAD`'s sha with `git rev-parse HEAD` (via `execFileSync`). Write a `land_queued` event carrying that sha into tick 3's block with `writeEvents`.
  - **Text form.** `cmdTick(repo, ["bugfix", "3"], false, false, true)` prints the unchanged header (including `· commit <short sha>`), and its stdout contains a ` | ` stat line naming a file that commit added (check which files `initProject` commits, and assert one of them).
  - **JSON form.** The same call with `json = true` parses, and its `stat` key holds the same stat line.
- A block with no `land_queued`/`landed` commit prints `(no commit: this tick queued no landing)` under `--stat`.
- A `land_queued` carrying `"0".repeat(40)` prints `(commit 0000000 is not in this repository)` (match whatever `shortSha` yields), and the command exits 0.
- The binary smoke test path: `cli(repo, "tick", "bugfix", "3", "--stat")` exits 0.
- `tick bugfix 3` without `--stat` prints byte-for-byte what it printed before, and its `--json` payload has no `stat` key.
- The existing usage-regex assertion in test/tick-detail.test.ts ("cmdTick fails with the usage on a missing, unknown, or extra positional and a bad n") is updated to the new `TICK_USAGE`. Every other existing test in test/tick-detail.test.ts, test/help.test.ts, and test/cli-arg-strictness.test.ts passes.

### `tumwater diff --role <id> --stat` prints per-file change summaries in place of the patches (done 2026-10-12; planned 2026-10-12 by plan; independent of the refused "Operator backlog writes land on main" part 2/2 above, and touches none of its files)

**Goal.** `tumwater diff --role <id>` prints a loop's full ahead-of-main patch and its full uncommitted patch. Each can run to 200 KB (`aheadOfMainDiff`'s default cap, and `DIFF_MAX_BYTES` in `src/change/change-data.ts`). The quick question an operator usually asks, "which files is this loop touching, and how much?", has no compact answer today. `git diff --stat` answers it. After this change, `--stat` prints the same header, commit lines, and uncommitted file list, with each patch replaced by its `git diff --stat` summary.

**Approach.**
- **Flag.** Add `export const STAT_FLAG: FlagSpec = { names: ["--stat"] };` to `src/cli/cli-flag-specs.ts`, beside `JSON_FLAG`. In `cmdDiff` (`src/cli/cli-query-commands.ts`), add it to the `rejectUnknownArgs("diff", …)` list.
- **Requires --role.** When `--stat` is present and `parseRoleFlag` returns null, `fail("diff --stat needs --role <id> (the fleet roster prints no patch)")`. The fleet view carries no patch, so the flag would mean nothing there.
- **Collector.** Give `collectRoleChange(root, role, opts: { stat?: boolean } = {})` in `src/change/change-data.ts` an options bag. When `opts.stat` is set:
  - `diff` becomes `(await gitTry(wt, "diff", "--stat", `${mainBranch}...HEAD`)) ?? ""`, still only when `ahead > 0`. It does not go through `aheadOfMainDiff`.
  - `uncommittedDiff` becomes `(await gitTry(wt, "diff", "--stat", "HEAD")) ?? ""`, still only when `dirtyFiles` is non-empty. It does not go through `cappedWorkingDiff`.
  - No cap applies: a stat summary is one line per file.
  - The `RoleChangeView` shape is unchanged. Update the doc comments on `diff` and `uncommittedDiff` to say that under `--stat` they hold the stat summary.
  - `cmdDiff` passes `{ stat: args.includes("--stat") }`. `collectFleetChanges` and the TUI's `collectChange` call keep the default (no options), so their behavior does not change.
- **Renderer.** No change: `renderRoleChange` already prints `view.diff` and `view.uncommittedDiff` verbatim after the commit lines and the `uncommitted (N files): …` line.
- **JSON.** `--stat --json` prints the same payload shape, with `diff`/`uncommittedDiff` holding the stat summaries.

**Files.** `src/cli/cli-flag-specs.ts`, `src/cli/cli-query-commands.ts`, `src/change/change-data.ts`, `src/cli/help.ts` (the `tumwater diff --role <id> [--json]` usage line becomes `[--stat] [--json]`, and its description gains "; --stat prints each patch's per-file `git diff --stat` summary instead"), README.md (the "See a loop's pending change" row gains a `--stat` clause), test/cli-diff.test.ts.

**Acceptance criteria.**
- New test in test/cli-diff.test.ts, using `seededFeatureRepo` plus an `fs.appendFileSync(path.join(wt, "widget.md"), "more\n")` uncommitted edit. `diff --role feature --stat` exits 0. Its stdout includes `1 commit ahead of main`, `add widget.md`, `uncommitted (1 file): widget.md`, and a `widget.md |` stat line. It includes neither `+# widget` nor `+more`.
- `diff --role feature --stat --json` parses. Its `diff` and `uncommittedDiff` each include `widget.md |`, and neither includes `+# widget`.
- `diff --stat` without `--role` exits nonzero, and its stderr includes `diff --stat needs --role`.
- Existing tests in test/cli-diff.test.ts, test/change-data.test.ts, test/change-render.test.ts, and the TUI tests pass unchanged. `diff --role feature` without `--stat` still prints `+# widget`.

### The doctor refusals row says when a refused plan's prerequisites have left `## Planned`, so a refusal that may be stale stands out (planned 2026-10-12 by plan; done 2026-10-12 by feature; independent of the refused "Operator backlog writes land on main" part 2/2 above, and touches none of its files)

**Goal.** `checkRefusedEntries` in `src/doctor/doctor-backlog.ts` warns about every refused entry in the same words. A common refusal is "prerequisite not landed yet". That refusal outlives its reason: no loop clears a Refused note, so once the prerequisite lands, nothing tells the operator the objection may be gone. The live repo shows this today. "Operator backlog writes land on main, part 2/2" is refused because part 1/2 had not landed, and part 1/2 is now under `## Done`. After this change, the refusals row adds a clause to such an entry saying its prerequisites are no longer planned, so the refusal may be stale.

**Approach.**
- **Helper.** In `src/backlog/backlog-eligibility.ts`, export `prerequisitesLanded(title: string, plannedParts: ReadonlySet<string>): PartRef[]`. It returns `requiredParts(title)` when that list is non-empty and none of its refs is in `plannedParts` (matched through the private `partKey`, the same way `entryHoldAgainst` matches). Otherwise it returns `[]`. A heading with no parseable `requires … landed` clause therefore never counts as stale. Leave `entryHoldAgainst` unchanged.
- **Check.** In `checkRefusedEntries`, build `const parts = plannedPartKeys(planned)` once from the PLANS.md entries list already read there (hoist `plannedPlanEntries(root)` into a local). Record `landed = prerequisitesLanded(entry.title, parts)` on each held item from both sources. This uses the same rule `backlogHolds` applies to both files.
- **Wording.**
  - When the first held entry's `landed` is non-empty, insert `; its prerequisite(s) <refs> are no longer planned, so the refusal may be stale` right after the truncated-note parenthetical. Render each ref as `${series} ${part}/${of}` (the `holdMark` rendering) and join with `, `.
  - In the `andMore` list, suffix each such entry with ` [prerequisites no longer planned]`.
  - All other text stays the same: the ok detail, the warn level, and the remedy tail (`answer the objection and delete the note, or retract …`).

**Files.** `src/backlog/backlog-eligibility.ts`, `src/doctor/doctor-backlog.ts`, `test/doctor-backlog.test.ts`, `test/backlog-eligibility.test.ts` (backlog helpers are tested there), README.md (the Audit row's "planned plans and open bugs held by a Refused note" gains ", flagging one whose prerequisites are no longer planned").

**Acceptance criteria.**
- `prerequisitesLanded` returns the refs for `S, part 2/2: x (planned 2026-10-12; requires part 1/2 landed)` against an empty set. It returns `[]` against a set built by `plannedPartKeys` from a `S, part 1/2: y` entry. It returns `[]` for a heading without a `requires` clause. It returns the refs for a wrapped heading whose `(planned …; requires part 1/2 landed. …` stays open past the line.
- A PLANS.md fixture with a refused `S, part 2/2: …; requires part 1/2 landed)` heading and no part 1/2 under `## Planned` makes `checkRefusedEntries` warn with `S 1/2 are no longer planned, so the refusal may be stale` in its detail. The same fixture plus a planned `S, part 1/2: …` entry warns without `may be stale`.
- A second refused entry with landed prerequisites shows ` [prerequisites no longer planned]` in the `(and N more: …)` list.
- The two existing `checkRefusedEntries` tests and the doctor row-order test in test/doctor.test.ts pass unchanged.

### A wrapped heading's prerequisite clause holds its plan: `requiredParts` reads a heading parenthetical that stays open past the heading line (planned 2026-10-12 by plan; done 2026-10-12; independent of the refused part 2/2 above, and touches none of its files)

**Goal.** `requiredParts` in `src/backlog/backlog-eligibility.ts` reads only `trailingParenthetical(title)`, which returns "" unless the heading line ends in `)`. A plan heading whose stamp parenthetical wraps onto the following lines has a `### ` line like `### X, part 2/2: y (planned 2026-10-12 by plan; requires part 1/2 landed. It reuses …`. For that heading `requiredParts` returns [], so `entryHoldAgainst` sees no prerequisite. The plan then reads as eligible in the prompt's `<backlog-index>`, in `tumwater backlog`, and in `eligibleEntries`, even while its prerequisite is still under `## Planned`. This happened to the "Operator backlog writes land on main, part 2/2" entry above: feature picked it up before part 1/2 landed and refused it. After this change, such a heading is marked `[blocked: requires …]` until the prerequisite leaves `## Planned`.

**Approach.**
- In `src/backlog/backlog-md.ts`, add an exported `openParenthetical(line: string): string` next to `trailingParenthetical`. Scan left to right with a depth counter and remember the index of the `(` that took depth from 0 to 1. A `)` at depth 0 is ignored. If depth is still above 0 at the end of the line, return the text after that remembered `(` (it is the outermost group still open). Otherwise return "".
- In `requiredParts`, use `trailingParenthetical(title)` and fall back to `openParenthetical(title)` when it returns "". The existing `/requires\s+(.+?)\s+landed\b/i` match and the `parseRef` loop stay as they are. Only the heading line (`entry.title`) is ever read, never the body. Continuation lines remain body, exactly as today.
- Update the doc comments that state the rule to name the fallback: `requiredParts`, `entryHold`, the module header of `backlog-eligibility.ts` (it says "trailing parenthetical"), and `trailingParenthetical`'s comment, which names `requiredParts` as a caller.
- No change to `seriesPart`, `stripEntryStamp`, `entryDates`/`headingMetadata`, or any renderer.

**Files.** `src/backlog/backlog-md.ts`, `src/backlog/backlog-eligibility.ts`, `test/backlog-eligibility.test.ts`. Add the `openParenthetical` tests to `test/backlog-eligibility.test.ts`, since there is no backlog-md test file.

**Acceptance criteria.**
- `requiredParts("Op writes, part 2/2: x (planned 2026-10-12 by plan; requires part 1/2 landed. It reuses part 1/2's module:")` returns `[{ series: "Op writes", part: "1", of: 2 }]`.
- `entryHold` for an entry with that title, with `Op writes, part 1/2: y (planned 2026-10-12)` in `planned`, returns `{ blockedBy: ["Op writes 1/2"] }`. With an empty `planned`, it returns null.
- `openParenthetical` returns "" for a balanced line (`"a (b) c"`, `"a (b (c))"`) and for a line with no `(`. It returns `"b (c) d"` for `"a (b (c) d"`. A stray leading `)` (`"a) b (c"`) yields `"c"`.
- Every existing `requiredParts` and `entryHold` test in `test/backlog-eligibility.test.ts` passes unchanged. That includes `requiredParts("Foo, part 1/2: x")` returning [], since the line has no open parenthetical.
- Against this repo's PLANS.md (`node -e` importing `dist/src/backlog/backlog-eligibility.js` after `npm run build`), `requiredParts` of the "Operator backlog writes land on main, part 2/2" heading returns the part 1/2 ref. That entry still reads `refused`, because the Refused note is checked first.

### `tumwater doctor` names refused backlog entries: a "refusals" check that warns on each planned plan or open bug held by a **Refused** note (done 2026-10-12; planned 2026-10-12 by plan; independent of both entries above, and touches none of their files except README.md's doctor row. A **Refused …** note holds its entry until a human or the director edits it, and no loop clears one. Today the only places that show the hold are the `[refused]` mark in `tumwater backlog`, `plan|bug --list`, and the prompt's backlog index. Nothing tells the operator that work is parked. This repo's part 2/2 above is such an entry right now: it was refused because part 1/2 had not landed, and `src/backlog/backlog-commit.ts` has since landed, but nothing says so. `grep -rn refused src/doctor` finds nothing)

**Goal.** `tumwater doctor` gains a "refusals" row. It warns when PLANS.md `## Planned` or BUGS.md `## Open` holds an entry with a Refused note, names the first entry (its file, its `--list` position, its title, and the note) plus the others in short form, and says how to release it. The dashboard's Health check card and the TUI's Health tab show the row with no code of their own, because both render `runDoctor`'s checks (`src/gui/gui-endpoints.ts`, `createTuiKeys` in `src/ui/tui/tui-keys.ts`).

**Approach.**
- **Note reader.** In `src/backlog/backlog-eligibility.ts`, export `refusalNote(body: string): string | null`, placed beside `hasNoteLine`. It returns the first body line whose trimmed start begins with `REFUSED_PREFIX`, trimmed, with a leading `**` and the first closing `**` removed (so `**Refused 2026-10-12 by feature: x**` gives `Refused 2026-10-12 by feature: x`). It returns null when no line matches. `entryHoldAgainst` keeps using `hasNoteLine`. The two agree by construction: the same prefix, matched as a line prefix.
- **Check.** In `src/doctor/doctor-backlog.ts`, add `export function checkRefusedEntries(root: string): CheckOutcome`:
  - It reads `plannedPlanEntries(root)` and then `openBugEntries(root)` (`src/backlog/backlog.ts`), in file order, and keeps the entries whose `refusalNote(entry.body)` is non-null. Each kept entry records `{ file: "PLANS.md" | "BUGS.md", command: "plan" | "bug", position: index + 1, title, note }`. `position` is the entry's 1-based index in its section, which is the number `tumwater plan|bug --list` prints and `--cancel <n>` takes (`listAndAnnounce` in `src/backlog/backlog-write.ts` numbers the same `plannedPlanEntries`/`openBugEntries` order).
  - Missing files give no entries, because those readers return [] for them.
  - With no kept entries it returns `okOutcome("no planned plan or open bug is held by a Refused note")`.
  - Otherwise it returns `warnOutcome` with this detail: `` `${file} ${command} #${position} "${title}" is held by a Refused note (${truncate(note, REFUSAL_NOTE_MAX)})` ``. That is followed by `andMore(rest, (e) => `${e.file} ${e.command} #${e.position} "${truncate(e.title, FIX_CLAIM_HEADING_MAX)}"`)` and then `` ` — no loop takes a refused entry until it is edited: answer the objection and delete the note, or retract the entry with \`tumwater ${command} --cancel ${position}\`` ``, where `command` and `position` are the first entry's. The first title is quoted in full, as `checkFixClaims` quotes its first heading.
  - Add the module constant `REFUSAL_NOTE_MAX = 120`, with a doc comment.
  - Write a doc comment shaped like `checkStrandedPlans`'s. It says the check reads the tree at `root` and warns but never fails, because a refusal is operator signal.
  - Update the module's top doc comment from "three checks" to four, and name refusals in it.
- **Compose.** In `runDoctor` (`src/doctor/doctor.ts`), add `{ name: "refusals", ...checkRefusedEntries(root) }` directly after the `"backlog headings"` row.

**Files.** `src/backlog/backlog-eligibility.ts`, `src/doctor/doctor-backlog.ts`, `src/doctor/doctor.ts`, test/doctor-backlog.test.ts, test/doctor.test.ts (the check-name list asserted at its top gains `"refusals"` after `"backlog headings"`), test/backlog-eligibility.test.ts (the `refusalNote` cases), README.md (the "Audit" row's `tumwater doctor` list gains "planned plans and open bugs held by a Refused note").

**Acceptance criteria.**
- `refusalNote("intro\n  **Refused 2026-10-12 by feature: too big**\nmore")` returns `"Refused 2026-10-12 by feature: too big"`. A body that only mentions `**Refused ` mid-line returns null, matching `entryHold`'s rule.
- In a tmpdir (`tmpdir` from test/fixtures/repo-fixtures.ts) with a PLANS.md whose `## Planned` holds an eligible entry followed by a refused one, and a BUGS.md whose `## Open` holds one refused bug:
  - `checkRefusedEntries(dir).level === "warn"`;
  - the detail matches `/PLANS\.md plan #2 "<the full refused title>" is held by a Refused note \(Refused 2026-10-12 by feature: /`;
  - it contains `(and 1 more: BUGS.md bug #1 "…")`;
  - it ends with `` `tumwater plan --cancel 2` ``.
- With the notes removed, or with neither file present, the check returns exactly `{ level: "ok", detail: "no planned plan or open bug is held by a Refused note" }`.
- A Refused note under `## Done` or `## Fixed` does not warn.
- test/doctor.test.ts's ordered check-name list includes `"refusals"` right after `"backlog headings"`, and the rest of the suite passes unchanged.

### TUI: a read-only Brief tab shows the initial prompt, matching `tumwater brief` and the dashboard's Settings card (planned 2026-10-12 by plan; sibling of the landed `tumwater brief` (`cmdBrief`, `src/cli/brief-command.ts`) and the landed dashboard Settings "Initial prompt" card (`GET /api/brief`). The project prompt says the GUI and TUI both give the user a main prompt and that the user only writes the initial prompt, yet the TUI cannot show it: `grep -rn brief src/ui/tui/` finds nothing. It is read-only because the TUI's prompt line holds one line and a brief can be up to `INITIAL_PROMPT_MAX_CHARS` of multiline text. Replacing it stays a job for the CLI (`--file`) and the dashboard, the same split the TUI notebook view uses. Independent of the refused part 2/2 above: no `src/gui`, `src/ui/gui`, or `src/backlog` file changes) — done 2026-10-12

**Goal.** `Ctrl+T` gains a tenth stop, **Brief**, after Health. It shows the brief file's name and then the current initial prompt, the same text `tumwater brief` prints, and `PgUp`/`PgDn` scroll it.

**Approach.**
- **One renderer.** Add `renderBrief(brief: { file: string; prompt: string }): string` to `src/brief.ts`, returning `` `${brief.file}\n${brief.prompt}` ``. `cmdBrief`'s plain-text branch calls it instead of its inline template, so the CLI and the TUI cannot drift. `--json` is unchanged.
- **View.** Add `{ kind: "brief" }` to the `TuiView` union in `src/ui/tui/tui-frame.ts`. `tabStrip` appends `["brief", "Brief"]` after `["health", "Health"]`. `hintLine` gives `brief` the same key list as `health` (Enter send, ↑↓ history, PgUp/PgDn scroll, Ctrl+T next view, Ctrl+D quit).
- **Index.** The brief view is index `roleIds.length + 8`:
  - in `createTuiKeys` (`src/ui/tui/tui-keys.ts`), the Ctrl+T modulus goes from `roleIds.length + 8` to `roleIds.length + 9` (update its trailing comment to name brief), and the roster-change clamp goes from `Math.min(view, roleIds.length + 7)` to `+ 8`;
  - in `src/ui/tui/tui.tsx`'s pane mapping, insert `view === roleIds.length + 8 ? { kind: "brief" }` after the health arm.
- **Entry.** Add an `else if (view === roleIds.length + 8)` arm to the Ctrl+T handler's entry chain, after the Health arm. It is synchronous like Queued: `const brief = readBrief(root); paneCache = brief ? renderBrief(brief) : null;`. Each entry reads the file fresh. The existing `view >= roleIds.length + 2 && page !== null` branch already pages `paneCache`, so no paging change is needed.
- **Body.** In `paneBody` (`src/ui/tui/tui-pane.ts`), add a `brief` branch shaped like the `health` branch: it windows `paneCache` with `entryBodyWindow` when that is non-empty, and otherwise returns no lines. Its `emptyNote` is `"(no project brief with a prompt block — run \`tumwater init\` first)"`. Update the module's doc comment to list brief among the panes.

**Files.** `src/brief.ts`, `src/cli/brief-command.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui.tsx`, `src/ui/tui/tui-pane.ts`, test/tui-frame.test.ts, test/tui-keys.test.ts, test/tui.test.ts, docs/how-it-works.md (the `Ctrl+T` view list in the TUI bullet), README.md (the "Check state" row's `tumwater brief` entry also names the TUI's Brief tab and the dashboard's Settings card).

**Acceptance criteria.**
- `tabStrip({ kind: "brief" }, 200)` reads `Activity  Transcript  Backlog  Usage  Failures  History  Pending  Queued  Health  [Brief]   Ctrl+T next`. The existing `tabStrip` assertions in test/tui-frame.test.ts gain `  Brief` after `Health`.
- In test/tui-keys.test.ts, with no roles in an `initializedRepo()` fixture (test/fixtures/repo-fixtures.ts, whose README.md carries a prompt block), cycling from Health with one Ctrl+T gives `view === 8` and `paneCache === renderBrief(readBrief(root)!)`. One more Ctrl+T wraps to `view === 0` with `paneCache === null`. Existing tests that wrap past Health (the "eight cycles with no roles wrap back to Activity" loop, the "cycling past Health wraps to Activity" assertion, and the `health → activity` steps) take one more Ctrl+T and otherwise pass unchanged.
- With the brief's prompt block removed, entering Brief leaves `paneCache === null`, and `paneBody({ kind: "brief" }, …)` returns no body lines and the init emptyNote.
- In test/tui.test.ts, the cycle from Health shows `[Brief]` with the brief file's name in the frame before wrapping to `[Activity]`. Its existing `→ health` then `→ events`/wrap steps take one more Ctrl+T.
- `tumwater brief` without flags prints the same text as before (the existing brief-command tests pass unchanged).

### Dashboard: view and replace the initial prompt from the Settings view (planned 2026-10-12 by plan; done 2026-10-12 by feature; independent of the refused part 2/2 above and touches none of its files except docs/invariants.md. The landed `tumwater brief` (`cmdBrief`, `src/cli/brief-command.ts`) is the only way to read or replace the initial prompt. The project prompt says the GUI gives the user a main prompt and that the user only writes the initial prompt, yet the dashboard has no route that names the brief: `grep -n brief src/gui/*.ts src/ui/gui/*.ts` finds nothing. `cmdBrief` also keeps its checks (empty, `INITIAL_PROMPT_MAX_CHARS`, marker), its locked write, and its commit inline, so a second caller would have to copy them)

**Goal.** The Settings view gains an "Initial prompt" card. It shows the brief file's name and the current prompt in a textarea, and its Save button replaces the prompt under exactly the checks and commit `tumwater brief --file` applies.

**Approach.**
- **Shared writer.** Add `src/brief-edit.ts` exporting `editInitialPrompt(root: string, text: string): Promise<BriefEditOutcome>`, where `BriefEditOutcome` is `{ ok: false; error: string } | { ok: true; file: string; changed: boolean; committed: boolean }` (`file` is the basename). Move `cmdBrief`'s body after the arg parsing into it unchanged: trim, then the three refusals with their current messages, then `briefPath`, the `withStateLock(primaryWorktreeLockPath(root), …)` write through `replaceInitialPrompt`/`writeTextAtomic`, and `commitOperatorBacklogEdit(root, name, stampedSubject("operator", "Edit initial prompt"))` when changed. Each `fail(...)` becomes `return { ok: false, error }`. That includes the missing brief and the "no longer carries a prompt block" case, which returns its error from inside the lock callback.
- **CLI.** `cmdBrief` keeps its arg parsing and its show branch. Its `--file` branch calls `editInitialPrompt` and maps `ok: false` to `fail(error)`. Its printed lines and `--json` payload stay as they are.
- **Server.** In `src/gui/gui-endpoints.ts`, add `handleBrief(res, root)`. It answers 200 with `readBrief(root)`'s `{ file, prompt }`, or 404 with `{ error: "no project brief with a prompt block found — run \`tumwater init\` first" }`. In `src/gui/gui-endpoint-commands.ts`, add `handleBriefEdit(req, res, root)`, which reads the body through `readPostBody` with the example `'{"prompt": "…"}'`. A non-string `prompt` gets a 400 with `gotSuffix`, as `handleRoleNotes` does. Otherwise it awaits `editInitialPrompt` and answers 400 `{ error }` or 200 `{ file, changed, committed }`. Register `"GET /api/brief"` and `"POST /api/brief"` in `guiRoutes` (`startGui`, `src/gui/gui-server.ts`).
- **Client.** In `GUI_CLIENT_SETTINGS_JS` (`src/ui/gui/gui-client-settings.ts`), `buildSettingsView` adds a third card, `id='briefcard'`. It holds a `<form class='brief-form'>`, deliberately not `settings-row`, so the boot's delegated `form.settings-row` submit listener never routes it to `saveSetting`. The form has a heading naming the file, a `<textarea class='field' id='brief-text' rows='12'>`, and a Save button. `fetchBrief()` is called beside `fetchSettings(); fetchDoctor();` in the boot's switchView settings branch (`src/ui/gui/gui-client-boot.ts`) and fills the card from `GET /api/brief`, esc'ing both fields. A failure renders `errorPanel("Initial prompt could not load", err, "empty")`. `saveBrief(form)` posts `{ prompt: textarea.value }` to `/api/brief` and calls `showFlash`. The message is "Initial prompt unchanged" when `changed` is false, "Initial prompt saved (committed to main)" when `committed` is true, "Initial prompt saved" otherwise, and "error: <message>" on a rejection. In `src/ui/gui/gui-client-boot.ts`, add one delegated submit listener for `form.brief-form` beside the settings one.
- **Unchanged.** `src/brief.ts`, `tumwater brief`'s output, and every existing route.

**Files.** new `src/brief-edit.ts`, `src/cli/brief-command.ts`, `src/gui/gui-endpoints.ts`, `src/gui/gui-endpoint-commands.ts`, `src/gui/gui-server.ts`, `src/ui/gui/gui-client-settings.ts`, `src/ui/gui/gui-client-boot.ts`, tests (`test/brief-command.test.ts` stays as is; add cases to `test/gui-endpoints.test.ts` and `test/gui-client-settings.test.ts`), README.md (the "Steer the project" row: the dashboard's Settings view edits the initial prompt the same way), docs/invariants.md (INV-B5's Guarantee names the dashboard's initial-prompt Save, and Binds adds `src/brief-edit.ts` and `handleBriefEdit`).

**Acceptance criteria.**
- `GET /api/brief` on a `makeRepo` fixture returns the README's file name and prompt. On a repo without a prompt block it returns 404 with the error above.
- `POST /api/brief` with `{"prompt": "new idea"}` in a repo on main returns `{ changed: true, committed: true }`. Afterwards `readBrief` returns "new idea", `git status --porcelain` is empty, and HEAD's subject is `tumwater(operator): Edit initial prompt`. A repeat returns `changed: false` and adds no commit.
- `POST /api/brief` with an empty prompt, a prompt over 4096 characters, a prompt containing `<!-- tumwater:prompt:start -->`, or a non-string `prompt` returns 400, leaves the brief file byte-for-byte unchanged, and adds no commit.
- The settings client test checks four things: `buildSettingsView` emits `briefcard`; `fetchBrief` fills the textarea esc'd and paints the error panel on rejection; `saveBrief` posts the textarea's text and flashes each of the three success messages; and a submit on `form.brief-form` does not call `saveSetting`.
- The existing `test/brief-command.test.ts` cases pass unchanged.

### `tumwater brief`: show the initial prompt, and `--file <path>` replaces it and commits on main (planned 2026-10-12 by plan; independent of the refused part 2/2 above. It reuses the landed `commitOperatorBacklogEdit` (`src/backlog/backlog-commit.ts`) as it stands and does not touch any file part 2/2 names except README.md and docs/invariants.md. The initial prompt is the one input the project prompt says the user writes ("You only write the markdown/initial prompt"), yet no command reads or replaces it. `tumwater init` refuses to rewrite an existing brief and tells the user to hand-edit the marker block (`initProject` in `src/init/init.ts`). A hand edit skips init's `INITIAL_PROMPT_MAX_CHARS` check: `extractPrompt` in `src/brief.ts` then truncates the prompt silently on every tick. The edit also stays uncommitted in the primary checkout, where it blocks `ffMainTo`'s `merge --ff-only` the same way part 1/2's filings did. No CLI command names the brief today (`grep -n 'case "' src/cli.ts`)) (done 2026-10-12)

**Goal.** `tumwater brief` prints the project's initial prompt and the file that holds it. `tumwater brief --file <path>` (with `-` meaning stdin) replaces the prompt block's content under the same checks init applies, then commits that one file on main.

**Approach.**
1. **`src/brief.ts`.** Add a pure `replaceInitialPrompt(text: string, prompt: string): string | null`. It finds the block with `extractPrompt`'s ordering rule (the first `PROMPT_START`, then the first `PROMPT_END` after it) and returns the text with everything between the two markers replaced by `\n${prompt.trim()}\n`. Every byte outside the markers is kept. It returns null when the text has no well-formed block. Export a `briefPath(root): string | null` built on `firstBriefText(root, ownsBrief)`, giving the full path of the owning candidate, so the writer edits the same file every reader resolves.
2. **New `brief-command.ts` module in `src/cli/`, `cmdBrief(root, args)`.**
   - **Read.** With no `--file`, print the brief's basename on one line and the prompt after it (`readBrief`). With `--json`, print `{file, prompt}`. When `readBrief` returns null, fail with a message naming `tumwater init`.
   - **Write.** With `--file`, read the text through `readPromptFileArg` (`src/cli/cli-command-args.ts`), then trim it. Refuse the text before any write when it is empty, when it is longer than `INITIAL_PROMPT_MAX_CHARS` (reuse init's `tooLongMessage` wording if it is exported, otherwise state the cap in plain words), or when it contains `PROMPT_START` or `PROMPT_END`, since a nested marker would break the block for every reader.
   - **Lock and no-op.** Under `withStateLock(primaryWorktreeLockPath(root), …)` (the lock `appendEntry` takes), re-read the file and apply `replaceInitialPrompt`. When the result equals the current text, print `initial prompt unchanged` and exit 0 with no write and no commit. Otherwise `writeTextAtomic` the file.
   - **Commit.** After the lock is released, `await commitOperatorBacklogEdit(root, path.basename(file), stampedSubject("operator", "Edit initial prompt"))`. Print `initial prompt updated in <file>`, plus `(committed to main)` when the call returned true. With `--json`, print `{file, changed, committed}`. No wake: every loop reads the brief at its next tick.
   - **Arguments.** `rejectUnknownArgs("brief", args, [JSON_FLAG, FILE_SPEC])`, using a local `{ names: ["--file"], value: true, valueName: "<path>" }` like `cli-query-commands.ts`'s `FILE_SPEC`, so a positional is refused as an unknown argument. Call `requireReadyRepo(root)` after the args check, as `retire` does.
3. **`src/cli.ts`.** Add a `case "brief":` that lazy-imports `cmdBrief`, as the `questions` case does.
4. **Help and docs.** Add a `tumwater brief [--json]` stanza and a `tumwater brief --file <path> [--json]` stanza to `src/cli/help.ts`. Add `"brief"` to the command list in test/help.test.ts. In README.md's usage table, add `tumwater brief` to the "Check state" row and `brief --file` to the "Steer the project" row. In docs/invariants.md, widen INV-B5's statement and **Binds** to name the brief write and the new `brief-command.ts` module.

**Files.** `src/brief.ts`, a new `brief-command.ts` module in `src/cli/`, `src/cli.ts`, `src/cli/help.ts`, README.md, docs/invariants.md, test/brief.test.ts (the `replaceInitialPrompt` cases), a new `brief-command.test.ts` in test/ (build the repo with `makeRepo` from test/fixtures/repo-fixtures.ts, following test/backlog-commit.test.ts), and test/help.test.ts.

**Acceptance criteria.**
- `replaceInitialPrompt` keeps every byte outside the markers, and it returns null for text with no markers or with an end marker only before the start. When a `PROMPT_END` appears in prose before the real block, it replaces the real block, matching `readInitialPrompt`.
- In a repo on main, `tumwater brief --file p.md` makes `tumwater brief` print the new prompt. It also leaves `git status --porcelain` empty, with HEAD's subject `tumwater(operator): Edit initial prompt`.
- A second run with the same file prints `initial prompt unchanged` and leaves HEAD where it was.
- A file that is empty, longer than `INITIAL_PROMPT_MAX_CHARS`, or that contains a tumwater:prompt marker fails nonzero, with the brief file byte-for-byte as before and HEAD where it was.
- When TUMWATER.md owns the block, the write edits TUMWATER.md and leaves README.md alone.
- `tumwater brief extra` fails as an unknown argument. `tumwater brief --json` prints `{file, prompt}`.

### Operator backlog writes land on main, part 1/2: a filed plan or bug is committed as `tumwater(operator): File <kind>: <title>` (planned 2026-10-12 by plan; independent of every other entry; part 2/2 below builds on its helper. `tumwater bug`/`tumwater plan` (`fileAndAnnounce` → `announceFiled` in `src/backlog/backlog-write.ts`), the dashboard's New form (`handleBacklogFile` in `src/gui/gui-endpoint-commands.ts`), and the TUI backlog pane's Ctrl+N (`createTuiKeys` in `src/ui/tui/tui-keys.ts`) all write through `appendEntry`, which rewrites the primary checkout's PLANS.md/BUGS.md under `primaryWorktreeLockPath` and never commits: `src/backlog`'s only git use is backlog-structure.ts's read-only `changeBaseRev`/`fileContentAt`, and no writer there stages or commits. So the entry is invisible to the loop the command wakes, whose worktree branches from main. The `<backlog-index>` block (`renderBacklogIndexBlock`, read from the primary checkout) names it with line ranges that do not match the loop's own PLANS.md. And the dirty file makes `ffMainTo`'s working-tree arm (`src/landing/landing-git.ts`) fail: `git merge --ff-only` refuses with "Your local changes to the following files would be overwritten by merge" (reproduced 2026-10-12 in a scratch repo) on every landing that touches that file, until a human commits it by hand (e.g. commit faadab30, "BUGS.md: file stale-claim persistence…"). This is CLI-side only: no landing, scheduler, or event change) (done 2026-10-12)

**Goal.** Every surface that files a new plan or bug commits that one file on main right after the write, so main holds the entry, the woken loop sees it, and the primary checkout stays clean for the next fast-forward.

**Approach.**
- A new module `backlog-commit.ts` in `src/backlog/`, exporting `commitOperatorBacklogEdit(root: string, file: string, subject: string): Promise<boolean>`. Inside `withStateLockAsync(primaryWorktreeLockPath(root), …)` (the lock `ffMainTo`'s working-tree arm takes, so the commit and a fast-forward cannot interleave):
  1. Resolve `primary = await currentBranch(root)` and `main = targetBranch(loadConfigSafe(root).config?.baseBranch, primary)`, the resolution `collectRoleChange` in `src/change/change-data.ts` uses.
  2. Return false when `primary` is null or differs from `main`. That is the case where `ffMainTo` takes its ref-push arm and the working tree is not main's, so the write stays uncommitted as today.
  3. Otherwise run `gitTry(root, ...COMMIT_IDENT, "commit", "--only", "-m", subject, "--", file)` and return whether it succeeded. `--only` with a pathspec commits just that file's working-tree content (any earlier uncommitted operator edits to it included) and leaves other staged or dirty paths alone.
  The helper never throws: a git failure returns false and the entry stays written, as today. Build the subject with `stampedSubject("operator", "File " + kind + ": " + title)` from `src/git/commit-message.ts`, so `commitSubject` strips it like a loop's stamp.
- Keep `appendEntry` and the sync `fileBug`/`filePlan`/`fileEntryWithBody`/`*FromText` writers unchanged, so their direct callers and tests are unaffected. Commit after the write instead:
  - **CLI.** Make `announceFiled` async. It awaits `commitOperatorBacklogEdit(root, filed.file, …)` before `submitRolePromptAndWake`, so the woken loop's next sync sees the commit. `fileAndAnnounce` awaits it on both its `--file` and positional paths. The `kind` is the `command` argument (`bug`/`plan`). Printed output and `--json` payloads are unchanged.
  - **Dashboard.** `handleBacklogFile` awaits the commit after `fileEntryWithBody` and before its wake.
  - **TUI.** The Ctrl+N branch of the entry editor in `createTuiKeys` calls `void commitOperatorBacklogEdit(…)` after `fileEntryWithBody`. That is fire-and-forget, because the key handler is synchronous and the helper never rejects. The wake and flash stay synchronous, so "backlog Ctrl+N files a plan by title and wakes the feature loop; Ctrl+N again files a bug" in test/tui-keys.test.ts keeps passing as written (its rig root is not a git repo on main, so the helper returns false).
- The gap between the sync write and the async commit is milliseconds. A fast-forward landing in it fails as `merge_blocked`, and the batch re-stacks (`BATCH_RESTACK_ATTEMPTS` in `src/landing/landing-stack.ts`), which is strictly better than today's file that stays dirty indefinitely.

**Files.** a new module `backlog-commit.ts` in `src/backlog/`, `src/backlog/backlog-write.ts`, `src/gui/gui-endpoint-commands.ts`, `src/ui/tui/tui-keys.ts`, a new `backlog-commit.test.ts` in `test/`, README.md ("Steer the project" row: filed entries are committed to main), docs/invariants.md (one INV-B entry: "an operator-filed entry is committed on main under the primary-worktree lock", pinned to the new test).

**Acceptance criteria.**
- In a `makeRepo` + `initProject` repo on main, `tumwater bug "x"` through the test `cli` helper leaves `git status --porcelain` empty, and `git log -1 --format=%s` reads `tumwater(operator): File bug: x`. The same holds for `tumwater plan "y"` (`File plan: y`) and for `tumwater plan --file <path>`.
- With an unrelated file staged beforehand, filing a bug commits only BUGS.md, and the unrelated file is still staged.
- With the primary checked out on a branch other than the base branch, filing leaves BUGS.md modified in the working tree and HEAD unchanged. `commitOperatorBacklogEdit` returns false and does not throw. It also returns false for a non-git directory.
- `POST /api/backlog-file` in a git repo on main leaves the checkout clean, with the operator commit on top.
- Existing tests pass unchanged, including "a filed bug cannot be clobbered by a landing that fast-forwards the same file" (test/backlog-write.test.ts) and the TUI Ctrl+N test named above.

### `tumwater doctor` sizes the worktree pool: the "worktree pool" row sums the last 24 h of `slot_wait` events and warns when leases waited 10 minutes or more in total (planned 2026-10-12 by plan; independent of every other entry. `logSlotWait` in `src/git/worktree-pool.ts` logs a `slot_wait` event (`role`, `purpose`, `waitedMs`, `slots`, `pinned`) whenever a pooled lease waited `SLOT_WAIT_EVENT_MS` (30 s) or more. Both `plans/worktree-pool.md` ("Observability (part 5/5)") and docs/how-it-works.md's "Worktree pool" bullet call it "the signal to raise `worktreeSlots`". But nothing adds those events up. `grep -rn slot_wait src` finds only the logger, the event union in `src/events/events.ts`, `formatEvent`'s case in `src/events/event-format.ts`, and a doc comment in `src/files/json-object.ts`. Today an operator who wants to size the pool has to scroll `tumwater logs --grep slot_wait` and add the waits by hand. `checkWorktreePool` in `src/doctor/doctor-checks.ts` reports only slots, leases, pins, and leftover checkouts. Stands alone: no pool, scheduler, event, GUI, or TUI change. The dashboard's Health check card and the TUI Health tab render `runDoctor`'s rows, so they show the new text with no extra work) (done 2026-10-12)

**Goal.** `tumwater doctor`'s existing "worktree pool" row says how much slot contention the last day saw, and warns when it adds up to enough to justify raising `worktreeSlots`.

**Approach.**
- `src/doctor/doctor-checks.ts`: add two module constants next to `checkWorktreePool`: `SLOT_WAIT_CHECK_WINDOW_MS = 24 * 3600_000` and `SLOT_WAIT_WARN_TOTAL_MS = 10 * 60_000`. In `checkWorktreePool(root, now = Date.now())`, after the existing parts are built, read `readEventsSince(root, SLOT_WAIT_CHECK_WINDOW_MS).events` (from `src/events/event-window.ts`, as `checkNotify` in `src/doctor/doctor-notify.ts` does). Keep `ev.type === "slot_wait" && ev.ts >= now - SLOT_WAIT_CHECK_WINDOW_MS`. Fold them into a count, a total of `finiteNumber(ev.waitedMs, 0)` (`src/files/json-object.ts`), and the longest wait together with its `role` and `purpose` (`"vet"` when `purpose === "vet"`, else `"tick"`, matching `formatEvent`).
  - No waits: add no part. The row text and level are unchanged from today.
  - One or more waits: push the part `` `${plural(count, "slot wait")} in the last 24h, ${shortSpanPhrase(total)} total, longest ${shortSpanPhrase(longest)} (${role} ${purpose})` ``. Get `plural` and `shortSpanPhrase` from `src/text/phrases.ts`.
  - When `total >= SLOT_WAIT_WARN_TOTAL_MS`, append `` ` — raise worktreeSlots above ${slots.length}` `` to that part, and the row's level becomes warn. The existing leftover and stale-pin conditions still warn as before. Under the threshold the waits are information only: the level stays as the other conditions decide.
  - A throw from the read (an unreadable log) pushes `could not read the event log for slot waits: ${errorMessage(err)}` and leaves the level unchanged. The "event log" row already reports an unreadable log, so this row does not double-warn.
- Update `checkWorktreePool`'s doc comment to name the third warn condition.
- `docs/how-it-works.md` "Worktree pool" bullet: after the `slot_wait` sentence, add that `tumwater doctor`'s "worktree pool" row sums the last 24 h of those waits and warns once they total 10 minutes, naming the number to raise `worktreeSlots` above.
- `README.md`'s Audit row `tumwater doctor` sentence: add "slot waits that call for a larger `worktreeSlots`" to the list of what doctor names. Leave the tumwater:prompt block untouched.

**Files touched.** `src/doctor/doctor-checks.ts`, `test/doctor-checks.test.ts`, `docs/how-it-works.md`, `README.md`.

**Acceptance criteria.**
- The existing test "checkWorktreePool reports the pool, warns on a 25 h pin and on leftover legacy checkouts" in `test/doctor-checks.test.ts` passes unchanged. Its fresh repo logs no `slot_wait`, so the first `deepEqual` still reads `"0 slots, 0 leased, 0 pinned"`.
- A new test in `test/doctor-checks.test.ts` seeds real event lines with `logEvent` from `src/events/events.ts` (as `test/doctor-notify.test.ts` does) and covers:
  1. Two `slot_wait` events (`waitedMs` 45_000 on `feature` tick, 90_000 on `clean` vet) give level ok, and the detail matches `/2 slot waits in the last 24h, 2m total, longest 90s \(clean vet\)/`.
  2. Adding a `slot_wait` with `waitedMs: 600_000` on `feature` tick turns the level to warn, and the detail matches `/raise worktreeSlots above 0/` (the fresh repo has no slots file).
  3. A `slot_wait` whose `ts` falls before `now - 24h` is not counted. Pass a `now` far enough ahead of the logged events that they fall out of the window, and the detail no longer matches `/slot wait/`.
- `grep -n slot_wait src/doctor/doctor-checks.ts` finds the new filter.
- `npm run test` passes.

### The notify hook pages when main goes red: the once-per-SHA red-main warning becomes a typed `main_red_hold` event on the allowlist (planned 2026-10-12 by plan; independent of every other entry. When main's declared check fails, `mainRedGate` in `src/baseline/main-red.ts` holds every code loop (each tick ends `main_red`), and no change merges until a bugfix lands. This is the fleet's widest stop after `supervisor_exit`. Today `warnMainRedOnce` logs it as a generic `warning` on loop `harness` through `warnEventBestEffort`. `NOTIFY_EVENT_TYPES` in `src/events/notify.ts` matches on event type and deliberately leaves `"warning"` off, so a red main pages nobody. The operator finds out from the dashboard's "main is red" alert or from `tumwater doctor`'s "main red" row, and only if they happen to look. Stands alone: no scheduler, gate, snapshot, GUI, or TUI change) (done 2026-10-12)

**Goal.** The first time this process sees a verified-red main SHA, it logs one typed `main_red_hold` event, and the configured `notify` command pages it. The feed line keeps today's wording. It still fires once per red SHA, and never for an unverified or skipped baseline.

**Approach.**
- `src/events/events.ts`: add `| "main_red_hold"` to the `HarnessEvent["type"]` union, next to `maintenance_quota_hold`. Its trailing comment states that `warnMainRedOnce` (src/baseline/main-red.ts) logs it once per process per newly verified red main SHA, that every code loop skips authoring until main is green, and that it carries `sha`, `script`, and `message`.
- `src/baseline/main-red.ts`, `warnMainRedOnce`: keep the `lastMainRedSha` guard. Replace the `warnEventBestEffort(...)` call with `logEventBestEffort(root, { loop: "harness", type: "main_red_hold", sha: red.sha, script: red.script, message: redMainMessage(red, "code merges blocked until main is green") })`. Also update `warnMainRedOnce`'s doc comment and the "one harness-level warning per newly-discovered red SHA" wording in the `lastMainRedSha` comment. `warnEventBestEffort` stays imported, because `mainRedGate`'s skip and unverified paths still use it.
- `src/events/event-format.ts`, `formatEvent`: add `case "main_red_hold": return textOr(e.message);`. The message already reads `main <sha> is red (<script>: <headline>) — code merges blocked until main is green`, so the feed line is today's line minus the `warning: ` prefix. Add a one-line comment saying the tone comes from `PROBLEM_EVENTS`.
- `src/ui/tone.ts`: append `"main_red_hold"` to `PROBLEM_EVENTS` so the dashboards still tone the line as a problem, as they did when it was a `warning`.
- `src/events/notify.ts`: append `"main_red_hold"` to `NOTIFY_EVENT_TYPES` after `"disk_low"`, with a trailing comment in the same style as its neighbours ("main's own check is red — every code loop is held until a fix lands"). Add `src/baseline/main-red.ts` to the module doc's list of files that log allowlisted types in the orchestrator's process. `mainRedGate` and `mainTipVerdict` both run in-process: in the loop runner and the landing slot.
- `test/fixtures/log-fixtures.ts`: add `mainRedHolds(root)`, which returns `eventsOfType(root, "main_red_hold")`.
- README.md: in the `notify` sentence's list of when it runs ("… an error-streak breaker trip, a failed landing, …"), add "main's own check going red".

**Tests that this change breaks and must be updated** (they count the red-main notice through `harnessWarnings`/`warningEvents`). Switch each to `mainRedHolds`, keeping its count and message assertions:
- `test/main-red.test.ts`: "mainRedGate blocks a red main with the terminal outcome and a harness-level warning". Assert one `main_red_hold` on loop `harness` whose `message` contains the short SHA, `test`, and `baseline-failure`, and whose `sha` equals `mainSha(root)`. Also update the "warns once per red SHA" test, the healer-shares-the-guard assertion ("the healer's check did not add a second warning"), and the `mainTipVerdict` once-per-SHA test.
- `test/loop-red-main.test.ts`: the end-to-end red-main test (`harnessWarnings(repo)` with `/is red \(test: baseline-failure-line\)/`) and the bugfix-healer test (`harnessWarnings(repo).length === 1`). The unverified/skip test asserts `harnessWarnings(repo).length === 0`, which would now pass vacuously. Change it to assert that `mainRedHolds(repo)` is empty, and keep its skip-warning assertion.
- `test/notify.test.ts`: in "NOTIFY_EVENT_TYPES and NOTIFY_MIN_GAP_MS stay pinned to the planned allowlist and gap", add `"main_red_hold"` after `"disk_low"`.
- Grep `test/` for any other `PROBLEM_EVENTS` literal pin, and update it if one exists.

**New tests.**
- `test/notify.test.ts`: a `newNotifier` test in the style of the existing allowlisted-type tests. A `main_red_hold` event spawns the hook with `TUMWATER_EVENT_TYPE=main_red_hold`, `TUMWATER_EVENT_LOOP=harness`, and a `TUMWATER_EVENT_MESSAGE` that starts `main ` and contains `is red`.
- `test/event-format-fleet.test.ts` (beside the `disk_low` cases): add a case: formatting `{ type: "main_red_hold", loop: "harness", message: "main abc1234 is red (test: x) — code merges blocked until main is green" }` returns that message with no `warning:` prefix.

**Files touched.** `src/events/events.ts`, `src/baseline/main-red.ts`, `src/events/event-format.ts`, `src/ui/tone.ts`, `src/events/notify.ts`, `test/fixtures/log-fixtures.ts`, `test/main-red.test.ts`, `test/loop-red-main.test.ts`, `test/notify.test.ts`, the formatEvent test file named above, README.md.

**Acceptance criteria.**
- `grep -n 'main_red_hold' src/events/notify.ts src/events/events.ts src/events/event-format.ts src/ui/tone.ts src/baseline/main-red.ts` finds a hit in each file.
- `grep -n 'warnEventBestEffort' src/baseline/main-red.ts` no longer matches inside `warnMainRedOnce`.
- A verified red SHA logs exactly one `main_red_hold` (with `loop: "harness"`, `sha`, `script`, `message`) per process, and no harness `warning` for that SHA. A second blocked tick, the bugfix handoff, or a `mainTipVerdict` on the same SHA logs nothing more. An unverified or skipped baseline logs no `main_red_hold`.
- With `notify` configured, the first `main_red_hold` spawns the hook once. `NOTIFY_MIN_GAP_MS` throttles a burst the same way it throttles every other type.
- The failure digest's warning section (`messageSection(current, "warning", …)` in `src/failure/failure-data.ts`) no longer lists red-main notices. This is intended: those ticks are already itemized in the error section via `main_red` outcomes (INV-C1). Make no change there.
- README's notify sentence names main going red.
- `npm run test` passes.

### `tumwater doctor` names a red main: a "main red" check that warns on code loops held by the red-main gate (planned 2026-10-12 by plan; independent of the waiting "Idle loops say why they are idle, part 2/2") — done 2026-10-12

**Goal:** doctor's hold checks cover the pause, quiet hours, budget, claude window, maintenance quota, and error streaks, but not the hold that stops every code loop: `mainRedGate` (src/baseline/main-red.ts) ending each blocked tick `main_red` while main's suite is red. The table shows `main red` per loop, but doctor, its `--json`, the dashboard's Health card, and the TUI's Health tab say nothing. Add the check, computed from the same fact the status phase reads, so the two surfaces cannot disagree.

**Approach:**
- Move `mainCheckRecovered(mainCheck, s)` out of src/ui/status-model.ts into src/status/status-polls.ts, next to `MainCheckStatus` and `mainCheckForPoll`, and export it. Type its first parameter `MainCheckStatus | undefined`, which is what `StatusSnapshot["mainCheck"]` is. Keep its doc comment. status-model.ts imports it from there, and `loopPhase`'s `"main red"` rung is otherwise unchanged. The doctor module does not import from src/ui.
- In the same file, add and export `heldByMainRed(s: LoopState, mainCheck: MainCheckStatus | undefined): boolean`, returning `s.lastResult === "main_red" && s.queuedSummary === undefined && !mainCheckRecovered(mainCheck, s)`. `loopPhase`'s rung becomes `if (heldByMainRed(s, mainCheck)) return "main red";`, which gives one predicate to both surfaces.
- In src/doctor/doctor-holds.ts, add `checkMainRed(root: string, config: TumwaterConfig | undefined): CheckOutcome`, shaped like `checkErrorStreaks`:
  - An undefined config returns `okOutcome("not checked — tumwater.json unreadable")`.
  - Otherwise, for `loopIds(config).map((id) => loadLoopState(root, id))`, keep the states for which `heldByMainRed(s, mainCheckForPoll(root, config))` holds, with the main check read once. Sort them by role.
  - None held returns `okOutcome("no loop held by a red main")`.
  - Otherwise return `warnOutcome(\`red main holds ${plural(n, "code loop")}: ${roles.join(", ")}${cause}${healer}\`)`:
    - `cause` is ` — ${squash(first.lastError, 160)}` from the first held state that carries a `lastError` (mainRedGate's outcome error, "main <sha> is red (<script>: <headline>) — authoring skipped until main is green"), or empty.
    - `healer` is `; the bugfix loop is exempt and repairs it` when `loopIds(config)` contains an id whose `baseRoleOf` is `"bugfix"`, else `; no bugfix loop is enabled to repair it — fix main by hand or enable bugfix`.
  - It is a warn, not a fail: a red main does not stop the fleet from running.
- src/doctor/doctor.ts `runDoctor`: add `{ name: "main red", ...checkMainRed(root, config) }` directly after `"error streaks"`. The TUI Health tab (`runDoctor` via src/ui/tui/tui-keys.ts) and the dashboard Health card (`GET /api/doctor` in src/gui/gui-endpoints.ts) render `runDoctor`'s list, so they pick the row up with no change of their own.
- README.md: in the Audit row's `tumwater doctor` parenthetical, after "loops failing tick after tick (and whether they are paused)", add ", and code loops held by a red main".

**Files:** src/status/status-polls.ts, src/ui/status-model.ts, src/doctor/doctor-holds.ts, src/doctor/doctor.ts, test/doctor-holds.test.ts, test/doctor.test.ts, README.md.

**Acceptance criteria:**
- test/doctor-holds.test.ts gains `checkMainRed` cases, with states written through `saveLoopState` the way `streakRoot` does:
  - an undefined config is "not checked";
  - no state at `main_red` is ok;
  - a `feature` state with `lastResult: "main_red"` and a `lastError` warns naming `feature`, "1 code loop", and the squashed error;
  - the same state carrying a `queuedSummary` is ok;
  - with a `build_check` event appended to the event log carrying `scope: "landing"` and `status: "passed"` (one of the scopes `mainCheckForPoll`'s scan accepts) with a `ts` after the state's `lastTickEndedAt`, the state is ok;
  - with `bugfix` among the enabled loops the detail names the bugfix loop as the repairer, and without it the detail says no bugfix loop is enabled.
- test/doctor.test.ts's pinned check-name list gains `"main red"` right after `"error streaks"`.
- The existing test/status-model.test.ts cases around the main-red label (the ones exercising `snap.mainCheck`) pass unchanged.
- `grep -n "function mainCheckRecovered" src/ui/status-model.ts` finds nothing.
- `npm run test` passes.

### Idle loops say why they are idle, part 2/2: the status phase names the skip (planned 2026-10-12 by plan; requires part 1/2 landed) — done 2026-10-12

Second half of the split of the BUGS.md open entry "The dashboard says "Queued · due — waiting for a free slot"…". It reads `LoopState.skipReason`, which part 1/2 ("…part 1/2: the scheduling poll records why it skipped a due loop") adds. When this part lands, move that BUGS.md entry to `## Fixed` with a Fixed line that names this plan and the tests below.

**Goal:** a due loop the poll skipped reads as what it is, in the CLI/TUI table and on the GUI page, instead of the catch-all `queued`.

**Approach:**
- src/ui/status-model.ts `loopPhase`: in the final fallthrough (after the `nextRunAt > Date.now()` sleeping branch, where it now returns `"queued"`), map `s.skipReason` as follows:
  - `"no-free-entry"` → `idle: no unclaimed plans`, or `idle: no unclaimed bugs` when `baseRoleOf(s.role) === "bugfix"`;
  - `"claim-hold"` → `idle: sibling mid-entry`;
  - `"deferred-backlog"` → `deferred (backlog open)`;
  - `"deferred-no-work"` → `deferred (no new work)`;
  - absent → `"queued"`, as today.
  Every earlier rung keeps precedence (stopped, running, landing, holds, main red, failing, sleeping). Update the ladder's doc comment.
- `idleClaimText` (same file): drop the `phase === "queued" && instanceIndex(s.role) >= 2` inference. A claim's title is still returned when one is held. Otherwise return null, because the phase label now carries the idle reason itself. Remove the then-unused `instanceIndex` import if nothing else in the file uses it.
- src/ui/gui/gui-client-model.ts `phaseInfo` (the browser twin):
  - `p.startsWith("idle: ")` → `{ key: "idle", label: "Idle", tone: "gray", live: false, detail: p.slice(6) }`;
  - `p.startsWith("deferred (")` → `{ key: "deferred", label: "Deferred", tone: "gray", live: false }`, with the detail being the parenthesized clause: "backlog open" or "no new work";
  - the `queued` detail becomes "due — starts on the next poll", which is true once the named skips have their own labels.
  `loopRank` needs no change: unlisted labels already rank 4 (idle) in both twins. Confirm by test, not by assumption.
- src/ui/gui/gui-client-loops.ts: drop the `(l.instanceOf && info.key === "queued")` arm of the activity branch, so it reads `else if (l.claim)`, and drop the "idle — no unclaimed …" text there. The pill detail now carries it. Update the comment.

**Files:** src/ui/status-model.ts, src/ui/gui/gui-client-model.ts, src/ui/gui/gui-client-loops.ts, test/status-model.test.ts, test/gui-client.test.ts, BUGS.md.

**Acceptance criteria:**
- test/status-model.test.ts: new cases show `loopPhase` returning each of the five labels for a due, idle state carrying the matching `skipReason`. A sleeping state with a stale `skipReason` still reads `sleeping (…)`, and a running one still reads as running.
- The existing test "idleClaimText names the claimed entry, or why an extra instance is idle" is rewritten (it pins the dropped inference): claim titles are still returned, and `idleClaimText({ role: "feature-2" }, "queued")` is now null.
- test/gui-client.test.ts "every phase label loopPhase renders maps to a known status on the page" gains the new labels. Each maps to a non-`other` key (`idle` / `deferred`), and `loopRank` agrees between the server model and the browser twin.
- The page's queued detail no longer contains "slot" or "deferred": `grep -rn 'waiting for a free slot' src/ui` finds nothing (the phrase survives only in unrelated landing/worktree comments).
- The BUGS.md entry has moved to `## Fixed` with today's Fixed date.
- `npm run test` passes.


### Idle loops say why they are idle, part 1/2: the scheduling poll records why it skipped a due loop (planned 2026-10-12 by plan; done 2026-10-12 by feature)

Split from the BUGS.md open entry "The dashboard says "Queued · due — waiting for a free slot" for loops that are not waiting for a slot…", which needs review as too large for one run. Part 2/2 ("…part 2/2: the status phase names the skip") reads what this part records. This part changes no rendered output.

**Goal:** `pollRunnerReasons` (src/orchestrator/orchestrator-scheduling.ts) skips a due loop silently in three long-lived ways: an idle extra instance with no free entry, the claim-group hold, and a need-based deferral. The deferral verdict lives only in the in-memory `deferredDue` map, so the status readers (which load state files) cannot tell these apart, and every one falls through to `loopPhase`'s catch-all `"queued"`. Persist the skip reason on the loop's state so part 2 can label it.

**Approach:**
- src/loop/loop-state.ts: add `export type SkipReason = "no-free-entry" | "claim-hold" | "deferred-backlog" | "deferred-no-work"` and an optional `LoopState.skipReason?: SkipReason`, with a doc comment in the style of `heldElsewhere`: set by the scheduling poll when a due loop is skipped for one of these reasons, and cleared when the poll admits the loop or finds it not due. In `loadLoopState`, drop a saved value that is not one of the four strings (`delete s.skipReason`), so a hand-edited or future value reads as absent.
- src/orchestrator/orchestrator-scheduling.ts: add a module-private `noteSkip(root, runner, reason: SkipReason | undefined)`. It assigns `runner.state.skipReason` and calls `saveLoopState(root, runner.state)` **only when the value changes**, so a loop that stays skipped writes its state file once per episode, not once per poll. This follows the persisted claim release in the same function: a skipped loop gets no tick to save its own state. Call it:
  - with `"deferred-backlog"` / `"deferred-no-work"` in the `if (deferredNow)` branch, mapping `DeferReason` `"backlog"` / `"no-work"`;
  - with `"claim-hold"` before the `if (claimGroup.hold) continue;`;
  - with `"no-free-entry"` before the idle-extra `continue` (`instanceIndex(runner.role) >= 2`);
  - with `undefined` in the `if (!run)` branch, before the merge-queue interlock `continue` (`queuedRoles.has`), before the maintenance-headroom `continue`, and immediately before `reasons.set(runner, reason)` (admitted).
  The earlier gate `continue`s (pauses, holds, disk/restart) leave the value alone. Those states have their own `loopPhase` labels, which rank ahead of the catch-all, and the next poll that reaches the sites above rewrites the value.
- No event, config knob, or schema version change: the field is optional, and an older state file simply lacks it.

**Files:** src/loop/loop-state.ts, src/orchestrator/orchestrator-scheduling.ts, test/orchestrator-scheduling.test.ts, test/orchestrator-defer.test.ts, docs/invariants.md (only if a new guarantee entry fits an existing section; otherwise none).

**Acceptance criteria:**
- test/orchestrator-scheduling.test.ts "an extra instance with no free entry is skipped and keeps its schedule" also asserts `feature2.state.skipReason === "no-free-entry"` and the same value from `loadLoopState(root, "feature-2")`. The test's existing assertions (unchanged `nextRunAt`/`backoffSeconds`, no claim) still hold.
- A new test in the same file: a group held by an unclaimed mid-entry runner (reuse the fixture behind "a base with an outstanding revision and no claim also holds the group") leaves the sibling with `skipReason === "claim-hold"`. Once the hold clears and the sibling is admitted, `skipReason` is undefined in memory and on disk.
- A new test in test/orchestrator-defer.test.ts, next to "once: a due maintenance role with an open backlog settles as deferred, runs no tick, and logs the episode": the deferred role's state reads `"deferred-backlog"` on disk. A second poll with the same verdict does not rewrite the file (assert that its mtime, or a spy on the save, stays unchanged).
- `loadLoopState` drops an unknown `skipReason` string (a unit test in test/loop-state.test.ts).
- No rendered output changes: test/status-model.test.ts and test/gui-client.test.ts pass untouched.
- `npm run test` passes.

### `tumwater doctor` names a broken notify hook: a "notify" check that warns when recent pages failed (planned 2026-10-12 by plan; builds on the landed "A failing notify hook says so" plan. When the configured hook exits nonzero, is killed, or cannot start, `spawnNotifyCommand` in `src/events/notify.ts` logs a `warning` event on loop `harness` whose message starts with `notify command `. Its sources are `notifyExitWarning` and the two `notify command could not start: …` strings. Today grep finds no `notify` in `src/doctor`, so doctor says nothing about the push channel. With a typo'd hook, every page since startup was lost, and doctor still prints "ready to run". The operator learns about it only from `tumwater logs` or by running `tumwater notify --test` after the page they needed went missing. Stands alone: no scheduler, event-type, GUI, or TUI change. The dashboard's Health check card and the TUI Health tab render `runDoctor`'s rows, so they show the new row with no extra work) (done 2026-10-12)

**Goal.** Add a doctor row named `notify`. It reports whether a notify command is configured and warns when that command failed to page within the last 24 hours. The warning names how many pages failed and quotes the latest failure.

**Approach.**
- `src/events/notify.ts`: export `NOTIFY_FAILURE_PREFIX = "notify command "` and build every failure message from it: both `could not start` strings and both `notifyExitWarning` returns. The wording must stay the same character for character, so the existing assertions in `test/notify.test.ts` still pass. Export a pure predicate `isNotifyFailure(ev: HarnessEvent): boolean`. It is true when `ev.type === "warning"`, `ev.loop === "harness"`, and `ev.message` is a string starting with the prefix. That way the doctor reader and the writer share one definition.
- A new `doctor-notify.ts` module in `src/doctor/`: add `checkNotify(root: string, config: TumwaterConfig | undefined, now: number = Date.now()): CheckOutcome`, built with `okOutcome`/`warnOutcome` from `./outcome.js`. It must never throw, so wrap the read in try/catch. A read error is a warn that names the error.
  - `config?.notify` absent or `""` → ok `no notify command configured — pages are off`.
  - Otherwise read the last day with `readEventsSince(root, NOTIFY_CHECK_WINDOW_MS)` from `src/events/event-window.ts`, where `NOTIFY_CHECK_WINDOW_MS = 24 * 3600_000` is a module constant, and filter with `isNotifyFailure`. `readEventsSince` computes its own cutoff from `Date.now()`, so re-filter on `ev.ts >= now - NOTIFY_CHECK_WINDOW_MS` to keep the `now` seam honest.
  - No failures → ok `configured — no failed pages in the last 24h`.
  - Failures → warn `<n> failed page(s) in the last 24h; latest <humanSeconds(age)> ago: <message>`. Take `humanSeconds` from `src/text/datetime.ts`. Pass the message through `squash` from `src/text/text.ts`. It already carries the `tumwater notify --test` hint. The row warns but does not fail, the same way the hold rows do: a dead webhook must not fail a scripted pre-flight.
- `src/doctor/doctor.ts` `runDoctor`: insert `{ name: "notify", ...checkNotify(root, config) }` directly after the `"event log"` row.

**Files touched.** `src/events/notify.ts`, a new `doctor-notify.ts` in `src/doctor/`, `src/doctor/doctor.ts`, `test/doctor.test.ts`, a new `doctor-notify.test.ts` in `test/` (or a section of `test/doctor-checks.test.ts`), `test/notify.test.ts`, and `docs/invariants.md` (the doctor section, if one lists row guarantees: grep it first).

**Acceptance criteria.**
- The fixed row-order array in `test/doctor.test.ts` "runDoctor composes the full report — fixed check order, not-running header, ready verdict" gains `"notify"` right after `"event log"`. That test's all-ok sweep still holds, because `readyRepo()` configures no notify command and therefore gets the ok "pages are off" row.
- New `checkNotify` tests, each writing events through `warnEvent`/`logEvent` into a temp repo:
  - No `notify` configured → ok and "pages are off".
  - Configured with no failure warnings → ok.
  - Configured, with one `notifyExitWarning("budget_paused", 127, null)` warning on loop `harness` → warn whose detail contains `1 failed page`, `code 127`, and `tumwater notify --test`.
  - A failure warning older than 24h before `now` → ok.
  - A `warning` with the same prefix on a non-`harness` loop, or a non-warning event, is not counted.
- A `test/notify.test.ts` test pins that `isNotifyFailure` holds for a warning built from each failure shape: exit code, killed by signal, and could not start.
- No string literal `"notify command"` appears in `src/` outside `NOTIFY_FAILURE_PREFIX`'s definition. Check with grep.
- `npm run test` passes.

### `tumwater doctor` names loops on an error streak: an "error streaks" check that warns on each loop failing tick after tick, and says which of them are paused (planned 2026-10-12 by plan; the failure sibling of the landed hold checks in `src/doctor/doctor-holds.ts` (`checkPause`, `checkQuietHours`, `checkBudget`, `checkClaudeWindow`, `checkMaintenanceQuota`). Today grep finds no `consecutiveErrors`/`ERROR_STREAK` in `src/doctor`. When the error-streak breaker (`pollStreakGate` in `src/gates/streak-gate.ts`) pauses a loop past `ERROR_STREAK_BREAKER` failures, it writes the same per-role marker `tumwater pause --role` writes. So doctor's "pause" row reads `ok — paused loops: feature`, as if the operator chose it, and doctor still prints "ready to run". A loop past `ERROR_STREAK_WARN` that is not yet paused is also invisible to doctor, though the dashboards' "failing tick after tick" alert (`fleetAlerts` in `src/ui/fleet-alerts.ts`) names it. Stands alone: no gate, scheduler, snapshot, GUI, or TUI change. The dashboard's Health check card and the TUI Health tab render `runDoctor`'s rows, so they show the new row with no extra work) (done 2026-10-12)

**Goal.** `tumwater doctor` names every enabled loop whose `LoopState.consecutiveErrors` is at or past `ERROR_STREAK_WARN` (from `src/tick/tick-apply.ts`), with its streak and last error. It also says whether the loop is paused, so an operator can tell a breaker-held loop from one they paused, and from one still burning ticks.

**Approach.**
- In `src/doctor/doctor-holds.ts`, add `export function checkErrorStreaks(root: string, config: TumwaterConfig | undefined): CheckOutcome`, written in the same shape as `checkBudget`:
  - `config === undefined` → `okOutcome("not checked — tumwater.json unreadable")`.
  - Load `loopIds(config).map((id) => loadLoopState(root, id))`. Keep only the states with `(s.consecutiveErrors ?? 0) >= ERROR_STREAK_WARN`, and sort them by role id.
  - If none are left → `okOutcome("no loop failing consecutively")`.
  - Otherwise `warnOutcome` with `"failing tick after tick: "` followed by one phrase per loop, joined with `"; "`. Each phrase is `` `${role}: ${n} failed ticks` ``. If the loop is in `new Set(pausedRoles(root))`, the phrase continues `, paused`. A paused loop whose streak is at or past `ERROR_STREAK_BREAKER` instead continues `` `, paused at the error-streak breaker's bar — \`tumwater resume --role ${role}\` once the cause is fixed` ``. Do not claim the breaker wrote the marker: the marker does not record who wrote it. When `lastError` is set, the phrase ends `` ` — last error: ${squash(s.lastError, 120)}` `` (`squash` from `src/text/text.ts`).
  - This is a warn, not a fail: doctor's verdict still counts only fails, and a failing loop does not stop the fleet from running.
  - Extend the module doc's opening list of checks to name `error streaks` (`checkErrorStreaks`), and add a short doc comment on the function in the style of its neighbours. The comment should say the check reads the same `consecutiveErrors` the breaker and `fleetAlerts` read, and the same `pausedRoles` marker the scheduler reads.
- In `src/doctor/doctor.ts` `runDoctor`, import the check and add `{ name: "error streaks", ...checkErrorStreaks(root, config) }` directly after the `"maintenance quota"` row.
- Tests:
  - In `test/doctor.test.ts`, the test "runDoctor composes the full report — fixed check order, not-running header, ready verdict" pins the row order. Insert `"error streaks"` after `"maintenance quota"` there. Its all-ok sweep still holds, because a fresh repo has no loop state.
  - In `test/doctor-holds.test.ts`, add `checkErrorStreaks` cases in the style of the existing `checkPause` tests. Seed state with `saveLoopState(root, { ...freshLoopState(id), consecutiveErrors: n, lastError })` from `src/loop/loop-state.ts`, and pause with `pauseRole` from `src/fleet/fleet-state.ts`. Cover these cases:
    1. Unreadable config → ok "not checked".
    2. No streaks, and a streak of `ERROR_STREAK_WARN - 1` → ok.
    3. An unpaused loop at `ERROR_STREAK_WARN` → warn naming the role, the count, and the squashed last error.
    4. A paused loop at `ERROR_STREAK_BREAKER` → warn containing `paused at the error-streak breaker's bar` and `tumwater resume --role <id>`.
    5. A paused loop below the breaker → `, paused` with no resume hint.
    6. A second instance id (`feature-2`, with `roles.feature.instances: 2`) is reported under its own id.
- README.md: in the Usage table's "Audit" row, add to the doctor parenthetical's list of what doctor names: `loops failing tick after tick (and whether they are paused)`.

**Files touched.** `src/doctor/doctor-holds.ts`, `src/doctor/doctor.ts`, `test/doctor-holds.test.ts`, `test/doctor.test.ts`, `README.md`.

**Acceptance criteria.**
- `tumwater doctor` prints an `error streaks` row directly after `maintenance quota`. It is ok with "no loop failing consecutively" on a healthy fleet. It warns, naming each enabled loop id at or past `ERROR_STREAK_WARN` with its count and last error, and marks paused loops as described above.
- The verdict is unchanged by this row (warn, not fail).
- The check is read-only: it calls no `saveLoopState`, `pauseRole`, or event write. The existing read-only assertion in the runDoctor full-report test still passes.
- The updated row-order test and the new `checkErrorStreaks` tests pass under `npm run test`.


### `tumwater doctor` names the claude subscription window: a "claude window" check that warns while a rejected window holds the subscription claude seams (planned 2026-10-12 by plan; the subscription sibling of the landed "budget" check (`checkBudget` in `src/doctor/doctor-holds.ts`) and the last fleet hold doctor does not report, after "pause", "quiet hours", "budget", and "maintenance quota". On a subscription-only claude fleet a run is exempt from the dollar cap, so "budget" reads ok while `pollFleetHold` in `src/fleet/fleet-polls.ts` holds every subscription claude seam until the rejected window's `resetsAt`, which can be hours away. Today grep finds no `claudeWindow`/`claude window` in `src/doctor`. So doctor prints "ready to run" over a fleet that starts no claude tick, and the operator has to read the status header's `Claude 5h · rejected` badge to learn why. Independent of the landed "A failing notify hook says so" plan: no `src/events` file. Stands alone: no scheduler, snapshot, GUI, or TUI change. The dashboard's Health check card and the TUI Health tab render `runDoctor`'s rows, so they show the new row with no extra work; done 2026-10-12)

**Goal.** `tumwater doctor` (and `--json`) gets a "claude window" row right after "budget". It warns while a rejected subscription window holds the claude seams, naming the window and the countdown to its reset. Otherwise it is ok and names the most constrained window's state.

**Approach.**
1. `src/doctor/doctor-holds.ts`: add an exported `checkClaudeWindow(root: string, now: number = Date.now()): CheckOutcome` and list it in the module doc's first sentence alongside the other holds. It reads `readClaudeAccount(root, now)` from `src/agent/claude/claude-account.ts`, which already flips a past-`resetsAt` window to `reset`.
   - When there is no account file, or `billing !== "subscription"`, return `okOutcome("no subscription window reported")`. API-billed claude windows never hold, as `claudeWindowObservation` already says.
   - Hold verdict: call `claudeWindowObservation(account, now)` from `src/fleet/fleet-polls.ts`, the same function the scheduler's `pollFleetHold` uses, so doctor cannot disagree with the hold. When it returns non-null, return `warnOutcome(\`${claudeWindowLabel(obs.windowType)} window rejected — subscription claude seams hold until it resets in ${humanSeconds(secondsUntil(obs.resetsAt, now))}\`)`. `windowType` and `resetsAt` are on the subscription-window observation. If the `HoldObservation` type makes them optional, narrow on `kind === "subscription-window"` and the field types. Do not add a non-null assertion without that narrowing.
   - Otherwise take `claudeWindowEntries(account)[0]`, the most constrained window. With no entries, return `okOutcome("subscription; no window reported yet")`. For `allowed_warning`, return ok `` `${label} window nearing its limit${pct}` ``. For any other status, return ok `` `${label} window ${status}${pct}` ``. `pct` is `` ` (${Math.round(u * 100)}% used)` `` when `utilization` is a number, else empty. A rejected window with `isUsingOverage: true` lands here and reads `rejected`, which is correct: overage spends, it does not hold.
   - The doc comment says: read-only, built on `claudeWindowObservation`, and a hold is a warn because it stops every subscription claude seam.
2. `src/doctor/doctor.ts`: import `checkClaudeWindow` and add `{ name: "claude window", ...checkClaudeWindow(root) }` right after the `"budget"` row in `runDoctor`'s `checks` list.
3. `README.md`: in the Audit row's `tumwater doctor` description, after "today's spend against the daily cap", add ", a claude subscription window holding the claude seams".

**Files touched.** `src/doctor/doctor-holds.ts`, `src/doctor/doctor.ts`, `test/doctor-holds.test.ts`, `test/doctor.test.ts`, `README.md`.

**Acceptance criteria.**
- New `test/doctor-holds.test.ts` cases for `checkClaudeWindow`, each seeding the account with `writeClaudeAccount(root, …)` and passing a pinned `now`:
  - With no account file, the result is ok with "no subscription window reported". An `api`-billed account with a `rejected` future window is also ok, not warn.
  - A subscription account with `five_hour` `rejected`, a `resetsAt` 2 h after `now`, and no overage gives a warn. The message contains `5h window rejected` and the `humanSeconds` countdown for 7200 s.
  - The same window with `isUsingOverage: true` is ok, not warn.
  - A `rejected` window whose `resetsAt` is at or before `now` is ok, because the reader flips it to `reset`.
  - `allowed_warning` with `utilization: 0.83` is ok, and its message contains `nearing its limit` and `83% used`.
  - A subscription account with `windows: {}` is ok, with "no window reported yet".
- `test/doctor.test.ts`: the check-name pin list in the test that asserts the order of `runDoctor`'s rows gains `"claude window"` between `"budget"` and `"maintenance quota"`. That is the one existing assertion this plan changes. Find it with `grep -n '"maintenance quota"' test/doctor.test.ts`.
- `grep -n "checkClaudeWindow" src/doctor/doctor.ts` finds the import and the row.
- The project's check (`npm run test`) passes.

### A failing notify hook says so: a nonzero exit logs one warning naming the code and the paged event (planned 2026-10-12 by plan; independent of the waiting "The notify hook pages when the fleet goes down" plan, and it touches the same spawn block in `src/events/notify.ts`. If that plan has landed, the spawn lives in its `spawnNotifyCommand(root, command, event)`. If not, it is still inline in `newNotifier`. Put the change wherever the spawn is at implementation time. Today the notifier spawns the hook with `stdio: "ignore"` and only listens for `error`, which fires when the shell itself cannot start. With `shell: true`, a typo'd or uninstalled binary (`notfy-send`, a missing `terminal-notifier`), a `curl -f` against a dead webhook, or a script that crashes all exit nonzero. That exit is dropped, because the module doc says "a nonzero exit is the command's problem, not the fleet's". So a broken hook silently swallows every page. The operator learns this only by running `tumwater notify --test`, which already reports the exit code (`runNotifyHook` in `src/cli/notify-command.ts`). They usually run it after the page they needed went missing.) (done 2026-10-12)

**Goal.** When the configured notify hook exits nonzero or is killed by a signal, the fleet logs one `warning` event from loop `harness`. The warning names the event type it was paging and the exit code or signal, and adds a "command not found" gloss for code 127. It tells the operator to check the hook with `tumwater notify --test`. The warning reaches `tumwater logs`, the TUI Activity feed, and the dashboard, like every other warning. The page itself is not retried, and the fleet's behavior is otherwise unchanged.

**Approach.**
1. `src/events/notify.ts`:
   - Add an exported pure `notifyExitWarning(type: string, code: number | null, signal: NodeJS.Signals | null): string | undefined`. It returns `undefined` for `code === 0`. For code 127 it returns `` `notify command exited with code 127 (command not found) paging ${type} — check it with \`tumwater notify --test\`` ``. For any other nonzero code it returns the same text without the gloss. For a signal (`code === null`) it returns `` `notify command was killed by ${signal} paging ${type} — …` ``, with the same suffix.
   - In the spawn block, next to the existing `child.on("error", …)`, add `child.on("exit", (code, signal) => { const message = notifyExitWarning(event.type, code, signal); if (message) warnEventBestEffort(root, "harness", message); })`. Keep `stdio: "ignore"`, `detached: true`, and `child.unref()` unchanged. The hook must still outlive the orchestrator, so capturing stderr through a pipe is out of scope: a piped hook could get SIGPIPE once the parent exits. An `exit` listener does not keep the event loop alive after `unref()`. So when the process is gone before the hook finishes, no warning is logged, which is acceptable. This includes the fleet-down plan's supervisor path, where the supervisor exits right after spawning. If the spawn itself fails, node emits `error` and no `exit` with a code, so the existing "could not start" warning stays the only one for that case. The implementer confirms this in the spawn-failure test below.
   - `"warning"` stays off `NOTIFY_EVENT_TYPES`, so a failure warning can never page in turn. The per-type `NOTIFY_MIN_GAP_MS` throttle already bounds spawns, so it also bounds these warnings.
   - Rewrite the doc comment above `newNotifier`. Replace "a nonzero exit is the command's problem, not the fleet's" with the new contract: a nonzero exit or kill is logged as one warning, and the page is not retried.
2. `src/config/config-schema.ts`: the `notify?: string` doc comment gains one clause: a nonzero exit logs a warning.
3. `docs/invariants.md`: add an entry next to INV-E1 with the next free `INV-E` number: "a notify hook that exits nonzero leaves a warning naming the paged type". It binds `notifyExitWarning` and the notifier's `exit` listener, and it is pinned by the spawn test below. Use `grep -n '^### INV-E' docs/invariants.md` to find the next number at landing time.
4. README.md's `notify` sentence (outside the tumwater:prompt markers, ending "verify it with `tumwater notify --test`") gains "; a hook that exits nonzero logs a warning".

**Files touched.** `src/events/notify.ts`, `src/config/config-schema.ts`, `test/notify.test.ts`, `docs/invariants.md`, `README.md`.

**Acceptance criteria.**
- New `test/notify.test.ts` unit test for `notifyExitWarning`: `(…, 0, null)` returns `undefined`. `("budget_paused", 127, null)` contains `code 127`, `command not found`, `budget_paused`, and `tumwater notify --test`. `("land_failed", 3, null)` contains `code 3` and not `command not found`. `("land_failed", null, "SIGKILL")` contains `SIGKILL`.
- New `test/notify.test.ts` spawn test, modelled on "a notify command whose spawn fails logs one warning and does not throw out of the listener". It uses a `subscribeEvents` collector of `warning` messages and `newNotifier(root)` with `update({ notify: "exit 3" })`, then logs a `budget_paused` event. `waitFor` sees exactly one warning matching `/exited with code 3 paging budget_paused/`. A second case with `notify: "tumwater-no-such-command-xyz"` sees a warning matching `/code 127 \(command not found\)/`.
- New spawn test: a hook that exits 0 (`recorderCommand(out)`) records its line and produces no warning. Wait for the recorded line with `waitFor`, then `sleep` briefly before asserting that the warnings are empty.
- The existing "a notify command whose spawn fails logs one warning and does not throw out of the listener" test still passes. Extend it to assert that, after a short `sleep`, the collected warnings hold exactly one entry (no second exit warning).
- The existing allowlist-pin test "NOTIFY_EVENT_TYPES and NOTIFY_MIN_GAP_MS stay pinned to the planned allowlist and gap" passes unchanged, because this plan does not touch the list.
- `grep -n "problem, not the fleet" src/events/notify.ts` finds nothing.
- The project's check (`npm run test`) passes.

### The notify hook pages when the fleet goes down: the supervisor runs `notify` on `supervisor_exit` (planned 2026-10-12 by plan; independent of the TUI Health tab plan. It edits the same `NOTIFY_EVENT_TYPES` list and module-doc count sentence as the landed sibling "The notify hook pages on the claude subscription window" plan (now in Done), so it builds on that list of eleven. Today the most page-worthy moment is silent: the hook never runs when the fleet dies. `newNotifier` (`src/events/notify.ts`) subscribes through `subscribeEvents`, which only sees events logged in the orchestrator generation's own process. When a generation exits unasked or the crash-loop guard trips, that process is already gone. The `supervisor_exit` event is written by the *supervisor* process: `superviseRunCommand` in `src/cli/cli-run.ts` calls `logEvent(root, fleetDownEvent(...))` from its `onFleetDown` hook. So nothing pages, and every other notify page stops too, because the process that sends them is down.) — done 2026-10-12

**Goal.** An operator with `notify` configured is paged once when the supervised fleet goes down without being asked to stop. Operator-requested stops (Ctrl+C, SIGTERM, `run --for` deadline) already log no `supervisor_exit`, so they page nothing.

**Approach.**
1. `src/events/notify.ts`:
   - Extract `newNotifier`'s spawn block (the `try { spawn(command, [], { shell: true, env: notifyCommandEnv(...stripTerminalControls(formatEvent(event))), stdio: "ignore", detached: true }) … child.on("error", …) } catch …` with its two `warnEventBestEffort` warnings) into a module-private `spawnNotifyCommand(root: string, command: string, event: HarnessEvent): void` (the exports test bans unused exports). `newNotifier` calls it after its allowlist and throttle checks, so its behavior does not change.
   - Add an exported `notifyFleetDown(root: string, event: HarnessEvent): void`. It reads the command with `loadConfigSafe(root)` from `src/config/config.ts`. A missing or invalid tumwater.json, or an absent or empty `notify`, returns silently: the 2026-09-22 fleet-down case was tumwater.json vanishing, so this path must never throw. Otherwise it calls `spawnNotifyCommand`. There is no throttle, because the supervisor exits right after this one event. Because the spawn is detached and unref'd, the hook outlives the exiting supervisor.
   - Append `"supervisor_exit"` to `NOTIFY_EVENT_TYPES` with a comment in the list's voice, such as `// the supervisor gave up — the fleet is down; paged from the supervisor process by notifyFleetDown, since no orchestrator is left to hear it`. That keeps the allowlist the single list of paging types, which `config-schema.ts` and `notify --test` users read.
   - Rewrite the module doc's "All eleven allowlisted types are logged by the orchestrator's own process (…)" sentence: every type but `supervisor_exit` is logged by the orchestrator's own process, and `supervisor_exit` is paged directly by `notifyFleetDown` from `src/cli/cli-run.ts`. Use the count that is true at landing time (`grep -c` the list).
2. `src/cli/cli-run.ts`, `superviseRunCommand`'s `onFleetDown`: keep the `HarnessEvent` that `logEvent` returns and pass it to `notifyFleetDown(root, event)`. Import it statically beside `logEvent`. The implementer confirms that `src/config/config.ts` does not import `src/events/notify.ts`, so the new import makes no cycle.
3. Docs, same commit:
   - The `notify?: string` doc comment in `src/config/config-schema.ts` gains `supervisor_exit` in its type list, plus a note that the supervisor runs this one.
   - README.md's `notify` sentence (outside the tumwater:prompt markers: "… a failed landing, a blocked restart, a posted question …") gains "the fleet going down".
   - Add a `docs/invariants.md` entry next to INV-E1 with the next free `INV-E` number: "a fleet that goes down unasked runs the configured notify hook once", binding `notifyFleetDown` and `superviseRunCommand`'s `onFleetDown`, and pinned by the end-to-end test below.

**Files touched.** `src/events/notify.ts`, `src/cli/cli-run.ts`, `src/config/config-schema.ts`, `test/notify.test.ts`, `test/cli-run-shutdown.test.ts`, `README.md`, `docs/invariants.md`.

**Acceptance criteria.**
- `test/notify.test.ts` "NOTIFY_EVENT_TYPES and NOTIFY_MIN_GAP_MS stay pinned to the planned allowlist and gap": the pinned literal list gains `"supervisor_exit"` at its new position. This test breaks on purpose and is updated.
- New `test/notify.test.ts` tests for `notifyFleetDown`:
  - With `writeConfig(root, { ...defaultConfig(), notify: recorderCommand(out) })`, a `supervisor_exit` event (`{ loop: "harness", type: "supervisor_exit", generation: 2, code: 1, ts }`) records one line with type `supervisor_exit`, loop `harness`, and message `formatEvent(event)`. Wait for it with `waitFor`.
  - With no tumwater.json, with a tumwater.json holding invalid JSON, and with `notify` absent, the call returns without throwing and records nothing.
- `test/cli-run-shutdown.test.ts` "a generation that dies unasked leaves a supervisor_exit event: the fleet is never down without a trace" gains a sibling test, or an extension, that sets `cfg.notify` to a recorder command writing to a file in the repo's temp dir. After `cli(repo, "run")` exits with code 1, it asserts exactly one recorded `supervisor_exit|harness|…` line (polled with a bounded `waitFor`, because the hook is detached).
- The existing tests in `test/cli-run-sigint.test.ts` and `test/cli-run-window.test.ts` that assert no `supervisor_exit` on operator stops still pass unchanged.
- `grep -n "eleven" src/events/notify.ts` finds no stale count.
- The project's check (`npm run test`) passes.

### The TUI runs `tumwater doctor`'s checks: a Health tab at the end of the Ctrl+T cycle (planned 2026-10-12 by plan; terminal sibling of the CLI `tumwater doctor` (`runDoctor` in `src/doctor/doctor.ts`, rendered by `renderDoctor` in `src/doctor/doctor-render.ts`) and the landed dashboard Health check card (`GET /api/doctor` in `src/gui/gui-endpoints.ts`, painted by `src/ui/gui/gui-client-settings.ts`). Today grep finds no `doctor` in `src/ui/tui`. So an operator watching a stuck fleet in the TUI must quit it or open a second terminal to learn that the fleet is paused, in quiet hours, over budget, maintenance-held, or short on disk. Stands alone: no `src/doctor`, `src/gui`, `src/ui/gui`, or CLI change) — done 2026-10-12

**Goal.** A ninth tab, "Health", after Queued in the TUI's Ctrl+T cycle. It shows the same text `tumwater doctor` prints (`renderDoctor(await runDoctor(root))`), recomputed on each entry to the tab.

**Approach.** Model it on the Pending pane, the cycle's one existing async collector:
- `src/ui/tui/tui-keys.ts`, `createTuiKeys`:
  - Add an injectable seam to `TuiKeysDeps` beside `collectPending`: `runDoctor?(root: string): Promise<DoctorReport>`, defaulting to `runDoctor` from `src/doctor/doctor.ts`. Tests then resolve a fixed report without probing binaries or git.
  - Widen the Ctrl+T wrap from `% (roleIds.length + 7)` to `% (roleIds.length + 8)`, and extend the trailing comment's view list with `→ health`.
  - In the Ctrl+T handler's `if (!refreshPaneCache("all"))` chain, add a `view === roleIds.length + 7` branch. It sets `paneCache = null` (the loading note shows), then calls `void runDoctorSeam(root).then(...)`. On resolve it sets `paneCache = renderDoctor(report)` and calls `deps.requestRender()`. On reject it calls `flashError(err)` and `deps.requestRender()`. Both arms first return early unless `view === roleIds.length + 7` still holds. This is the same stale-resolution guard, with the same reason, that the Pending branch comments.
  - Raise the clamp in `syncSnapshot` from `roleIds.length + 6` to `roleIds.length + 7`.
  - The PgUp/PgDn branch guarded by `view >= roleIds.length + 2 && page !== null` already scrolls `paneCache` panes. Check that it covers the new index unchanged. Add no new key: leaving the tab and coming back re-runs the checks, just as Pending re-collects.
- `src/ui/tui/tui-frame.ts`: add `| { kind: "health" }` to `TuiView`, add `["health", "Health"]` after `["queued", "Queued"]` in `tabStrip`, and add a `hintLine` branch for `view.kind === "health"` with the same keys as Pending (`Enter send`, `↑↓ history`, `PgUp/PgDn scroll`, `Ctrl+T next view`, `Ctrl+D quit`).
- `src/ui/tui/tui-pane.ts`, `paneBody`: add a `pane.kind === "health"` branch shaped like the `pending` one: window `state.paneCache` through `entryBodyWindow` when it is non-null, else no lines, with `emptyNote: "(running health checks…)"`.
- `src/ui/tui/tui.tsx`: in the view-index→`TuiView` chain, add `view === roleIds.length + 7 ? { kind: "health" }` before the activity fallback.
- `src/ui` may import `src/doctor` (the GUI server already does). The reverse stays forbidden, and this plan adds no `src/doctor` import of `src/ui`.

**Files touched.** `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui-pane.ts`, `src/ui/tui/tui.tsx`, `test/tui-keys.test.ts`, `test/tui-frame.test.ts`, `test/tui-history.test.ts` (it holds the `paneBody` pane tests), `docs/how-it-works.md` (the TUI paragraph that begins "The TUI shows the same alerts under its header" and lists the `Ctrl+T` cycle), and `README.md`'s Audit row (append "and the TUI's Health tab").

**Acceptance criteria.**
- With no roles, eight Ctrl+T presses from Activity land on index 7 (Health), and a ninth wraps to 0. When an injected `runDoctor` seam resolves a fixed `DoctorReport`, `state().paneCache` equals `renderDoctor` of that report after the promise settles, and `requestRender` was called.
- A seam that resolves after the operator has cycled away from Health leaves `paneCache` untouched. A rejecting seam flashes the error and leaves the pane on its loading note.
- `tabStrip({ kind: "health" }, 200)` reads `Activity  Transcript  Backlog  Usage  Failures  History  Pending  Queued  [Health]   Ctrl+T next`. The existing exact `tabStrip` assertions in `test/tui-frame.test.ts` gain `  Health` before `   Ctrl+T next`. `hintLine` for `{ kind: "health" }` includes `Ctrl+D quit` and `PgUp/PgDn scroll`, and is added to the all-views `Ctrl+D quit` loop.
- `paneBody({ kind: "health" }, …)` shows the loading note while `paneCache` is null and the cached report lines once it is set.
- These existing tests in `test/tui-keys.test.ts` change, and nothing else should need to: the "seven cycles with no roles wrap back to Activity" loop (becomes eight), the "cycling past Queued wraps to Activity" step (now lands on Health; one more press wraps), and the `// → pending → queued → activity` three-press loop (becomes four). Grep `name: "t" }` in `test/` to confirm that no other test counts the full cycle.
- The project's check (`npm run test`) passes.

### The notify hook pages on the claude subscription window: `claude_window_limited` and `claude_window_warning` join `NOTIFY_EVENT_TYPES` (planned 2026-10-12 by plan; independent of the TUI Health tab plan; the subscription sibling of the landed `budget_paused`/`budget_warning` pages. On a subscription-only claude fleet a run is exempt from the dollar cap, so `budget_paused` and `budget_warning` never fire. The constraint that actually binds is the claude.ai usage window: once it is rejected, `pollFleetHold` in `src/fleet/fleet-polls.ts` holds every subscription claude seam until `resetsAt`, which can be hours. It logs `claude_window_limited` once per window, and `pollClaudeWindowWarning` logs `claude_window_warning` at the first `allowed_warning`. Neither type is on the allowlist in `src/events/notify.ts`, so the push channel stays silent while the fleet stands still. Stands alone: no scheduler, event, GUI, or TUI change) — done 2026-10-12

**Goal.** An operator with `notify` configured is paged when the subscription window nears its limit and again when it rejects and holds the claude seams. These are the same two moments the dollar cap pages on for priced fleets.

**Approach.**
1. `src/events/notify.ts`: append `"claude_window_warning"` and `"claude_window_limited"` to `NOTIFY_EVENT_TYPES`, each with a trailing comment in the existing voice. For example: `// the claude.ai subscription window first reported allowed_warning — subscription claude seams still tick; the heads-up before the hold below` and `// a rejected subscription window holds every subscription claude seam until it resets — the subscription fleet's binding stop`. Place them after `"budget_paused"` so the money/quota pages sit together. Update the module doc's "All nine allowlisted types are logged by the orchestrator's own process (…)" sentence: it becomes eleven, and its emitter list gains `src/fleet/fleet-polls.ts`. Both events are logged by `pollFleetHold`/`pollClaudeWindowWarning`, which `src/gates/gate-polls.ts` calls in the orchestrator's poll, so `subscribeEvents` sees them. The implementer confirms this by grepping for the two call sites in `gate-polls.ts`.
2. Leave `claude_window_reset` off the list (a lift is good news, the same reason `role_cap_resumed` is off), and `rate_limit_hold` too. That hold is a minutes-scale, self-escalating backend-storm response, so paging on it would be noise. The window events need no throttle change: each fires once per window, and `NOTIFY_MIN_GAP_MS` still applies per type.
3. Docs, same commit:
   - In `src/config/config-schema.ts`, the `notify?: string` doc comment's parenthesized type list gains `claude_window_limited`.
   - README.md's `notify` sentence (outside the tumwater:prompt markers: "a budget pause, a budget warning at 80% of the cap while the gate is still open, an error-streak breaker trip, …") gains "a claude subscription window nearing its limit or holding the claude seams".
   - In `docs/backends.md`, the Billing and spend paragraph's sentence "A rejected subscription usage window holds subscription claude seams until it resets (the first `allowed_warning` is logged too)" gains: both events page a configured `notify` command.

**Files touched.** `src/events/notify.ts`, `test/notify.test.ts`, `src/config/config-schema.ts`, `README.md`, `docs/backends.md`.

**Acceptance criteria.**
- In `test/notify.test.ts`, the pinned literal list in "NOTIFY_EVENT_TYPES and NOTIFY_MIN_GAP_MS stay pinned to the planned allowlist and gap" gains the two types in their new positions. That test also gains an assertion that `claude_window_reset` is not included, with a message in the style of the existing `role_cap_resumed` one.
- A new test in `test/notify.test.ts`, modeled on "a posted question spawns the notify command once with the posting role and rendered line", does the following. It logs `{ loop: "harness", type: "claude_window_limited", windowType: "five_hour", resetsAt: <a future epoch ms> }` and asserts one recorded line with type `claude_window_limited`, loop `harness`, and message equal to `formatEvent(event)`. It then logs a `claude_window_warning` and asserts a second line of that type, since the per-type throttle does not suppress a different type.
- "non-allowlisted events spawn nothing, and an absent or empty notify disables the hook" also logs a `claude_window_reset` and still records zero lines.
- `grep -n "nine" src/events/notify.ts` finds no stale count.
- The project's check (`npm run test`) passes.

### `tumwater doctor` names the maintenance allowance: a "maintenance quota" check for the rolling-24 h landings against `maintenancePerWorkLanding` (done 2026-10-12; planned 2026-10-12 by plan; the last scheduler hold doctor does not report, after the landed "pause", "quiet hours", and "budget" checks (`checkPause`/`checkQuietHours`/`checkBudget` in `src/doctor/doctor-holds.ts`) and the existing "bootstrap" and "disk space" checks. Today grep finds no `maintenanceQuota`/`maintenance quota` in `src/doctor`. So when the window is full, doctor prints "ready to run" over a fleet whose clean/tests/dry/organize/improve/readme loops start no tick until the window rolls under. An operator who runs `doctor` to learn why those loops are idle then has to read the status table's `held: maintenance quota <used>/<allowance>` label. Stands alone: no scheduler, snapshot, GUI, or TUI change. The dashboard's Health check card renders `runDoctor`'s rows, so it shows the new row with no extra work)

**Goal.** `tumwater doctor` (and `--json`, and the dashboard Health check card) gets a
`maintenance quota` row that gives the rolling-24 h allowance verdict the scheduler enforces. The
row names used/allowance and, when the allowance is held, the maintenance loops it holds.

**Approach.**
- Add `checkMaintenanceQuota(root, config, aliveFleet: boolean, now = Date.now()): CheckOutcome`
  to `src/doctor/doctor-holds.ts`, beside `checkBudget`. Extend the module's header doc comment to
  list it.
  - `config === undefined` → `okOutcome("not checked — tumwater.json unreadable")`, the same
    as `checkBudget`.
  - Loops: `loopIds(config).map((id) => loadLoopState(root, id))`, the same as `checkBudget`.
    Pass each as `{ role: s.role, running: aliveFleet && s.running === true }`. A dead fleet's
    leftover `running` flag must not count as in flight.
  - Queued roles: `new Set(readLandingQueue(root).entries.map((e) => e.role))` (from
    `src/landing/landing-queue.ts`) when `aliveFleet`, else an empty set. A queued landing
    waits for a live drain, so only a live fleet's queue counts as in flight.
  - Verdict: `maintenanceQuotaForPoll(root, config.maintenancePerWorkLanding, loops, queued, now)`
    from `src/status/status-polls.ts`. The status snapshot uses this same function, and it wraps
    the pure `maintenanceQuota` verdict over `countMaintenanceWindow`. That way doctor, status,
    and the gate share one definition. `src/status` does not import `src/ui`, so doctor's no-`src/ui`
    rule holds.
  - Outcomes:
    - `held` non-empty → `warnOutcome("allowance reached — <used>/<allowance> maintenance landings in the last 24h; held until the window rolls under: <held sorted, comma-joined>")`.
      This is a warn because it stops a whole tier, the same as the fleet-wide holds.
    - Otherwise → `okOutcome("<used>/<allowance> maintenance landings in the last 24h (<maintenancePerWorkLanding> per work landing + <MAINTENANCE_DAILY_FLOOR> floor)")`.
      Import `MAINTENANCE_DAILY_FLOOR` from `src/gates/maintenance-quota.ts`.
    - `held` is empty when no maintenance loop is enabled, even if `used >= allowance`. In that
      case append `; no maintenance loop enabled` to the ok detail.
- In `runDoctor` (`src/doctor/doctor.ts`), add
  `{ name: "maintenance quota", ...checkMaintenanceQuota(root, config, orchestratorAlive(root, info)) }`
  right after the `budget` row. Read `info` the way the `budget` row does.
- Update the expected name list in `test/doctor.test.ts`'s fresh-root test, which pins every
  check name in order. Put `"maintenance quota"` after `"budget"`.

**Files touched.** `src/doctor/doctor-holds.ts`, `src/doctor/doctor.ts`,
`test/doctor-holds.test.ts`, `test/doctor.test.ts`, README.md (the `Audit` row's doctor
sentence: add "and the maintenance allowance's rolling-24 h use").

**Acceptance criteria.**
- `test/doctor-holds.test.ts` gets new tests that write `merged` events to `eventsLogPath(root)`.
  Copy the `writeEvents` pattern from `test/maintenance-quota.test.ts`, use a fixed `now`, and
  give every fixture its own tmp root (`maintenanceQuotaForPoll` memoizes a counter per root).
  The tests check:
  - under the allowance → ok, and the detail contains `used/allowance`;
  - 12 `clean` merges and no work merges, with `clean` enabled (the 12 floor reached) → warn,
    and the detail names `clean`;
  - the same window with `aliveFleet` false and a loop state saved with `running: true` → the
    running loop is not counted (used equals the landed count);
  - `config` undefined → ok, "not checked".
- `test/doctor.test.ts`'s fresh-root name list includes `"maintenance quota"` after `"budget"`,
  and the suite passes (`npm run test`).
- `tumwater doctor --json` carries the new row with no change to `renderDoctor` or the report
  shape, because the row goes through the existing `checks` array.

### `tumwater doctor` names the daily budget: a "budget" check for today's spend against `maxDailyCostUsd` and the per-role caps already reached (done 2026-10-12; planned 2026-10-12 by plan; the cost sibling of the landed "pause" and "quiet hours" checks (`checkPause`/`checkQuietHours` in `src/doctor/doctor-holds.ts`). Today grep finds no `budgetSpend`/`fleetDailyCost`/`roleCapVerdicts` in `src/doctor`. So once the fleet has spent its cap, doctor still prints "ready to run" over a fleet whose priced loops hold, or run on a fallback, until local midnight. A loop over its own `maxDailyCostUsdPerRole` entry is also invisible to doctor. Stands alone: no scheduler, snapshot, GUI, or TUI change. The dashboard's Health check card renders `runDoctor`'s rows, so it shows the new row with no extra work)

**Goal.** One read-only doctor row named `budget` that reports today's fleet spend against the cap, warns when the cap is reached, and names base roles over their own per-role cap. It uses the same definitions the scheduler and `status` use, so its verdict cannot disagree with the gate.

**Approach.**
- Add `checkBudget(root: string, config: TumwaterConfig | undefined, published: { spentUsd: number; capUsd: number } | null, now: number = Date.now()): CheckOutcome` to `src/doctor/doctor-holds.ts`, beside `checkQuietHours`. Extend the module's top doc comment to list the third check.
  - `config === undefined` (broken tumwater.json; `checkInit` reports it) → `okOutcome("not checked — tumwater.json unreadable")`.
  - States: `loopIds(config).map((id) => loadLoopState(root, id))` (`src/roles/loop-ids.ts`, `src/loop/loop-state.ts`; `doctor-checks.ts` already imports both).
  - Spend: `published?.spentUsd ?? fleetDailyCost(states, now)`, the same precedence as `status-data.ts`'s `publishedSpend ?? fleetDailyCost(loops, now)`. The running scheduler's figure includes runs charged since the last tick-end save. Cap: `config.maxDailyCostUsd`, read live, as status-data does.
  - Per-role: `[...roleCapVerdicts(states.map((s) => ({ role: s.role, state: s })), config.maxDailyCostUsdPerRole, now)]` from `src/gates/role-cap-gates.ts`, filtered to `over`. This is the gate's own grouped verdict: instances share their base role's cap and summed spend, and the director is exempt. Render each entry as `<base> (<budgetPhrase(v.spentUsd, cap)>)`, sorted by base role, joined with `, `, and prefixed `capped loops: `. A non-empty list is appended to the fleet phrase after `; `.
  - Fleet phrase and level, using `budgetReached`/`budgetWarning` from `src/budget/budget.ts` and `budgetPhrase` from `src/text/phrases.ts`:
    - cap `<= 0` → `no daily cap; <usd(spent)> spent today` (`usd` from `src/text/format.ts`), ok.
    - `budgetReached` → warn: `daily cap reached — <budgetPhrase> today; role loops run on their tier fallback or hold until local midnight (see the fallback row)`. Do not try to resolve fallback vs paused here: that needs pi's catalog and the breaker map, and the existing `fallback` row (`checkFallbackModel`) already reports it.
    - `budgetWarning` → ok: `<budgetPhrase> today — past 80% of the cap`.
    - otherwise ok: `<budgetPhrase> today`.
  - Per-role caps reached alone stay ok, like paused roles in `checkPause`: the operator chose those caps by name, and every other loop keeps ticking.
- In `runDoctor` (`src/doctor/doctor.ts`), add `{ name: "budget", ...checkBudget(root, config, (orchestratorAlive(root, info) && info?.budget) || null) }` directly after the `quiet hours` row. This is the same alive-guard idiom the `fallback` and `build` rows use.
- README.md: in the Usage table's Audit row, add "today's spend against the daily cap" to the doctor phrase that already names the pause and quiet-hours windows.

**Files touched.** `src/doctor/doctor-holds.ts`, `src/doctor/doctor.ts`, `test/doctor-holds.test.ts`, `test/doctor.test.ts`, README.md.

**Acceptance criteria.**
- New tests in `test/doctor-holds.test.ts` cover `checkBudget` with a temp root, loop state files written for enabled roles with today's `dayStamp` via `todayStamp(now)`, and an injected `now`:
  - undefined config → ok, "not checked".
  - cap 0 → ok, "no daily cap".
  - under 80% → ok with `$a of $b today`.
  - at or above 80% → ok, "past 80%".
  - reached → warn, naming "daily cap reached" and "fallback row".
  - a non-null `published` figure overrides the persisted sum, in both directions.
  - a state stamped yesterday counts $0.
  - a `maxDailyCostUsdPerRole` cap reached by `feature` → ok, `capped loops: feature (…)`.
  - a director-only per-role spend is never named.
- `test/doctor.test.ts`'s fresh-root name list (the only test pinning the row order, per grep for `"quiet hours"`) gains `"budget"` right after `"quiet hours"`.
- `src/doctor` imports nothing from `src/ui`.
- `npm run test` passes.

### `tumwater doctor` names quiet hours: a "quiet hours" check for the fleet window and per-role windows that are holding now (done 2026-10-12; planned 2026-10-12 by plan; this is the scheduled sibling of the landed "pause" check (`checkPause` in `src/doctor/doctor-holds.ts`). Today grep finds no `quiet` in `src/doctor`, so at 23:30 under `quietHours: "23:00-07:00"` doctor prints "ready to run" over a fleet that starts no role tick until 07:00. An operator who runs `doctor` to learn why the loops are idle then has to run `status` as well. This plan stands alone: it adds no snapshot, GUI, or scheduler change, and the dashboard's Health check card shows the new row without extra work)

**Goal.** `tumwater doctor` (and `--json`) gains one row, `quiet hours`, placed right after `pause` because both report deliberate holds on ticking. It decides membership with the same parser and predicate the scheduler's gate uses, so its verdict cannot disagree with the hold. Like every doctor check, it is read-only.

**Approach.**
1. In `src/doctor/doctor-holds.ts`, add and export
   `checkQuietHours(config: TumwaterConfig | undefined, now: Date = new Date()): CheckOutcome`. Build it from `quietHoursStatus`, `roleQuietHold` and `quietWindowEnd` in `src/scheduling/quiet-hours.ts`, plus `DIRECTOR_ROLE` from `src/roles/roles.ts`. Do not import `src/ui/badges.ts` (`quietBadge`), because doctor does not depend on the UI layer. Outcomes:
   - Fleet window: take `quietHoursStatus(config?.quietHours, now)`.
     - `window === null` (unset, blank, malformed, or a broken config, which `checkInit` already reports) adds no fleet phrase.
     - Inside the window: `warnOutcome` with `quiet now (<window>) — no role loop starts a tick until <quietWindowEnd(window)>; the director is exempt`. This is a warn for the same reason a fleet pause is: it stops every autonomous loop. A warn never changes doctor's exit code (`CheckOutcome`'s contract in `src/doctor/outcome.ts`).
     - Outside the window: the ok phrase `<window> (not in the window now)`.
   - Per-role windows: take the keys of `config?.quietHoursPerRole`, minus `DIRECTOR_ROLE`, that satisfy `roleQuietHold(config.quietHoursPerRole, key, now)`, sorted. When any are held, add the phrase `quiet loops: <role> until <end>, …`, where `<end>` is `quietWindowEnd` of that role's string. This alone is ok, for the same reason paused roles are ok in `checkPause`: the operator picked them by name. Configured per-role windows that are not holding now are not named.
   - Composition: no fleet window and no held roles gives `okOutcome("none configured")` when neither key holds a parseable window, otherwise `okOutcome(<fleet phrase>)`. Join the fleet phrase and the roles phrase with `; `, the same way `checkPause` joins its phrases. The level is warn only when the fleet window holds.
   - Update the module's top-level doc comment so it covers both holds. Each function's doc comment says it is read-only, that it reuses the scheduler's predicate, and why the levels split as they do.
   - To tell "none configured" from "configured, not holding" for per-role: if `quietHoursPerRole` has at least one non-director key whose `parseQuietHours(value).ok && window !== null`, say `per-role windows set, none holding now`. Otherwise say `none configured`. Use the exported `parseQuietHours`.
2. `src/doctor/doctor.ts`: import `checkQuietHours`, and add `{ name: "quiet hours", ...checkQuietHours(config) },` directly after the `pause` entry in `runDoctor`'s `checks` array. `config` is the `loadConfigSafe` result already in scope.
3. README.md's Audit row: extend the `tumwater doctor` parenthetical from "naming a standing fleet or per-role pause" to "naming a standing fleet or per-role pause or quiet-hours window holding now". Leave the rest of the row alone. Make no change to docs/invariants.md (the check adds no guarantee; it reuses the gate's predicate) and none to `src/cli/help.ts` (no flags change).

**Files touched.** `src/doctor/doctor-holds.ts`, `src/doctor/doctor.ts`, `test/doctor-holds.test.ts`, `test/doctor.test.ts`, README.md.

**Acceptance criteria.**
- New tests in `test/doctor-holds.test.ts`. Each passes a literal config object (cast to `TumwaterConfig`) and a fixed local `new Date(2026, 9, 12, H, M)`, so no test reads the wall clock:
  - `undefined` config, and `{}`, both give `{ level: "ok", detail: "none configured" }`.
  - `{ quietHours: "23:00-07:00" }` at 23:30 gives `warn`, with a detail containing `until 07:00` and `director is exempt`. At 01:00 it is also `warn` (the window wraps midnight). At 12:00 it is `ok`, with a detail containing `23:00-07:00` and `not in the window`.
  - `{ quietHoursPerRole: { cleanup: "09:00-17:00" } }` at 12:00 gives `ok`, with a detail containing `cleanup until 17:00`. At 18:00 it gives `ok` with `per-role windows set, none holding now`.
  - `{ quietHoursPerRole: { director: "00:00-23:59" } }` at 12:00 does not name `director`.
  - A fleet window holding plus a held role gives `warn`, and the detail names the role after `; `.
  - A malformed `{ quietHours: "nope" }` gives `ok` with `none configured`, because `checkInit` owns that error.
- `test/doctor.test.ts`: the pinned `report.checks.map((c) => c.name)` list in the fresh-root test gains `"quiet hours"` right after `"pause"`. That test's "every check but node is ok" loop still passes, because a fresh root has no `quietHours`.
- `grep -n '"quiet hours"' src/doctor/doctor.ts` shows the entry right after `pause`.
- `npm run test` passes.

### `tumwater doctor` names a standing operator pause: a "pause" check for the fleet pause (deadline, reason) and the per-role paused set (planned 2026-10-12 by plan; today `runDoctor` in `src/doctor/doctor.ts` has no check that reads the pause markers — grep finds no `isFleetPaused`/`standingFleetPause`/`pausedRoles` in `src/doctor`. So doctor can print "ready to run" over a fleet that will start no tick until `tumwater resume`, and an operator who runs `doctor` to learn why the loops are idle has to also run `status` to get the answer. Independent of the dashboard Health check card plan above: that one touches no `src/doctor` file, and once both land the card shows this row with no extra work, done 2026-10-12)

**Goal.** `tumwater doctor` (and `--json`) gains one row named `pause`, placed right after `bootstrap` because both report deliberate holds on ticking. It reads the same markers the scheduler reads, so its verdict cannot disagree with what the fleet does. It is read-only, like every doctor check.

**Approach.**
1. New module `doctor-holds.ts` in `src/doctor/` (doctor-checks.ts already runs past 500 lines). Export
   `checkPause(root: string, now: number = Date.now()): CheckOutcome`, built from `standingFleetPause`, `pausedRoles`, and `pausedRolesUntil` in `src/fleet/fleet-state.ts`, all of which never throw and treat an expired marker as absent. Countdowns use `humanSeconds(secondsUntil(until, now))` from `src/text/datetime.ts`, and the reason uses `pauseReasonSuffix` from `src/text/phrases.ts`. Do not import `src/ui/badges.ts`, because doctor does not depend on the UI layer. Outcomes:
   - No fleet pause and no paused roles: `okOutcome("not paused")`.
   - Fleet paused: `warnOutcome`. The detail is `fleet paused — no loop starts a tick until \`tumwater resume\`` when there is no deadline, or `fleet paused — auto-resumes in <countdown>` when the marker carries a future `until`. Either form then gets `pauseReasonSuffix(reason)`. When roles are also paused, append `; ` plus the roles phrase below. A fleet pause is a warn because it stops every loop. A warn never changes doctor's exit code (`CheckOutcome`'s contract in `src/doctor/outcome.ts`), so the verdict stays "ready to run".
   - Only roles paused: `okOutcome` with the roles phrase `paused loops: <a, b>`, plus ` (auto-resume in <countdown>)` when `pausedRolesUntil` is defined. This is ok because the operator chose those loops by name and every other loop keeps ticking.
   Doc comment: say which markers it reads, that it is read-only, and why the levels split as they do.
2. `src/doctor/doctor.ts`: import `checkPause` and add `{ name: "pause", ...checkPause(root) },` directly after the `bootstrap` entry in `runDoctor`'s `checks` array.
3. `src/doctor/outcome.ts`: add `doctor-holds.ts` to the top doc comment's list of modules that import from it.
4. Docs: README.md's Audit row changes `tumwater doctor` (pre-flight; …)` so the parenthetical also says it names a standing fleet or per-role pause. Keep the rest of the row as it is. No change to docs/invariants.md (no new guarantee: the check reuses the scheduler's readers) and none to `src/cli/help.ts` (no flag changes).

**Files touched.** a new `doctor-holds.ts` in `src/doctor/`, `src/doctor/doctor.ts`, `src/doctor/outcome.ts`, a new `doctor-holds.test.ts` in `test/`, `test/doctor.test.ts`, README.md.

**Acceptance criteria.**
- A new `doctor-holds.test.ts` in `test/` uses a `mkdtemp` root and writes the markers with the real writers `pauseFleet(root, untilMs?, reason?)` and `pauseRole(root, role, untilMs?)` from `src/fleet/fleet-state.ts`. It covers:
  - No markers gives `{ level: "ok", detail: "not paused" }`.
  - `pauseFleet(root)` gives `warn`, with a detail containing `tumwater resume`.
  - `pauseFleet(root, now + 90 * 60_000, "deploy freeze")` with `checkPause(root, now)` gives `warn`, with a detail containing `auto-resumes in` and `"deploy freeze"`.
  - `pauseRole(root, "cleanup")` alone gives `ok`, with a detail containing `cleanup`.
  - A fleet pause plus a paused role gives `warn`, and the detail names the role.
  - An expired fleet pause (an `until` in the past, written through `pauseFleet` if it accepts one, otherwise by writing the marker JSON directly to `pausedPath(root)` from `src/paths.ts`) gives `not paused`.
- `test/doctor.test.ts`: the pinned `report.checks.map((c) => c.name)` list in the fresh-root test gains `"pause"` right after `"bootstrap"`. That test's "every check but node is ok" loop still passes, because a fresh root has no pause marker.
- `grep -n '"pause"' src/doctor/doctor.ts` shows the entry right after `bootstrap`.
- `npm run test` passes.

### The dashboard's Settings view runs `tumwater doctor`'s checks: a Health check card over `GET /api/doctor` (planned 2026-10-12 by plan; sibling of the CLI `tumwater doctor [--json]` (`runDoctor` in `src/doctor/doctor.ts`, rendered by `renderDoctor` in `src/doctor/doctor-render.ts`, called from `src/cli.ts`). Today the dashboard has no doctor surface: grep finds no `doctor` in `src/gui` or `src/ui`. So an operator who sees a stuck fleet in the browser must switch to a terminal to learn that, say, the merge lock is stale, a work-instance claim names a gone entry, or disk is under the hold floor. Read-only: no new POST, no write path, and no `src/doctor` or `src/ui/tui` change) (done 2026-10-12)

**Goal.** The dashboard's Settings view gains a second card, "Health check". On each open of the Settings tab it runs the same checks `tumwater doctor` runs and paints the report: the header line, one row per check (level, name, detail), and the verdict. A Re-run button runs them again. The CLI and the dashboard read one `DoctorReport`, so they cannot disagree.

**Approach.**
1. `src/gui/gui-endpoints.ts`: add
   `export async function handleDoctor(res: http.ServerResponse, root: string, run: (root: string) => Promise<DoctorReport> = runDoctor): Promise<void>`
   that sends `sendJson(res, 200, await run(root))`. That is the same object `tumwater doctor --json` prints (`sayJsonOrRender(args, report, renderDoctor)` in `src/cli.ts`). Import `runDoctor` from `../doctor/doctor.js` and the `DoctorReport` type from `../doctor/doctor-checks.js`. The `run` parameter exists only so tests can skip the host probes. A throw reaches the server's outer 500, as `handleReclaim`'s doc comment says of that handler. Give it a doc comment in the style of its neighbours: read-only, the checks write nothing (`runDoctor`'s own contract), and it works whether or not the fleet is running.
2. `src/gui/gui-server.ts`: add `"GET /api/doctor": (_req, res) => handleDoctor(res, root),` to `guiRoutes` beside `"GET /api/config"`, and add `handleDoctor` to the existing import from `./gui-endpoints.js`.
3. `src/ui/gui/gui-client-settings.ts`, inside the `settings-view` region:
   - `buildSettingsView` appends a second card after `settingscard`: `<div class='card' id='doctorcard'>`, with a head row holding the title "Health check", the line "The same checks as `tumwater doctor`.", and `<button type='button' class='btn btn-sm' data-action='doctor-rerun'>Re-run</button>`, then a body `<div id='doctorbody'><div class='empty'>Checking…</div></div>`.
   - A pure `renderDoctorReport(d)` returns the body HTML: `esc(d.header)`, then one row per `d.checks` entry, then `esc(d.verdict)`. Each row is a level badge, the name, and the detail, all esc'd. Build the badge inline as `<span class='pill t-" + tone + "'>" + esc(level) + "</span>` with tone `green` for `ok`, `amber` for `warn`, and `red` for `fail`, using the existing `.t-*` classes in `src/ui/gui/gui-styles.ts`. Do not call `gui-client.ts`'s `pill`, because it sits outside the regions the settings test loads. A missing or non-array `checks` renders the rows as nothing; it does not throw.
   - `async function fetchDoctor()` calls `buildSettingsView()`, sets `doctorbody` to the Checking… placeholder, then `renderDoctorReport(await getJson("/api/doctor"))`. On error it paints `errorPanel("Health check could not run", err, "empty")`.
   - Update the file's top doc comment to mention the card and its endpoint.
4. `src/ui/gui/gui-client-boot.ts`: change `if (v === "settings") fetchSettings();` so it also calls `fetchDoctor()`. Add one delegated click listener beside the Settings Clear listener: `clickClosest(ev, "button[data-action='doctor-rerun']")` → `ev.preventDefault(); fetchDoctor();`.
5. Docs: in README.md's Audit row, after `--json prints the report as JSON, for scripts`, add `; the dashboard's Settings view runs the same checks in its Health check card`. In docs/how-it-works.md's Settings-view sentence ("Its Settings view shows the curated top-level config keys …"), add a sentence saying the view also runs `tumwater doctor`'s checks on each open, with a Re-run button. Neither docs/invariants.md nor `src/cli/help.ts` changes, because no guarantee or CLI flag changes.

**Files touched.** `src/gui/gui-endpoints.ts`, `src/gui/gui-server.ts`, `src/ui/gui/gui-client-settings.ts`, `src/ui/gui/gui-client-boot.ts`, `test/gui-endpoints.test.ts`, `test/gui-client-settings.test.ts`, README.md, docs/how-it-works.md.

**Acceptance criteria.**
- `test/gui-endpoints.test.ts`: `handleDoctor` with a stub `run` that returns a fixed `DoctorReport` answers 200 with exactly that report (`captureJson` from `./fakes/fake-res.js`), and the stub receives the `root` it was given.
- `test/gui-endpoints.test.ts`: a live-route test modelled on "the live server routes GET /api/logs to the slice handler" (`startLocalGui` on a `tmpdir()` root) fetches `/api/doctor` and gets 200. The body has a string `header`, an array `checks` whose entries each carry `name`, a `level` in `ok|warn|fail`, and `detail`, and a string `verdict`. The test does not pin the levels, because they depend on the host.
- `test/gui-client-settings.test.ts`: add `renderDoctorReport` and `fetchDoctor` to `settingsScope`'s name list. Then:
  - `renderDoctorReport` esc's the header, a check's name and detail, and the verdict (a `<b>&` detail does not appear raw), and maps `ok`/`warn`/`fail` to `t-green`/`t-amber`/`t-red`.
  - `renderDoctorReport({ header: "h", verdict: "v" })` (no `checks`) returns HTML holding both strings and does not throw.
  - `fetchDoctor` with an injected `getJson` that rejects paints the error panel into `doctorbody`.
  - The test "renderSettings renders one row per curated key …" still passes unchanged: the curated rows and `SETTINGS_KEYS` are untouched.
- `grep -n "doctor" src/ui/gui/gui-client-boot.ts` shows the Settings open path calling `fetchDoctor` and the `doctor-rerun` listener.
- `npm run test` passes.

### File a new plan request or bug from the TUI backlog pane: Ctrl+N opens a one-line title editor, matching `tumwater plan|bug "<title>"` and the dashboard's New form (planned 2026-10-12 by plan; sibling of the landed CLI `tumwater plan|bug` (`fileAndAnnounce` in `src/backlog/backlog-write.ts`), the landed dashboard New form (`handleBacklogFile` over `POST /api/backlog-file` in `src/gui/gui-endpoint-commands.ts`), and the landed TUI backlog pane's Ctrl+X cancel, Ctrl+E title edit, and Ctrl+A answer (`createTuiKeys`, `src/ui/tui/tui-keys.ts`). Today the TUI pane can cancel, retitle, and answer entries, but it cannot file a new one, so "file a bug about what I just saw" means switching to a second terminal. Only a title can be filed here: the prompt line holds one line, so a multiline body stays a CLI (`--file`) and dashboard job. No `src/gui`, `src/ui/gui`, `src/cli`, or `src/backlog` file changes) — done 2026-10-12

**Goal.** On the Backlog view (`view === roleIds.length + 1`), Ctrl+N opens the prompt line as a "new plan" title editor, and Ctrl+N again inside that editor switches it to "new bug" (and back). Enter files the entry and wakes its loop, exactly as `handleBacklogFile` does with an empty body. Esc cancels and writes nothing.

**Approach.**
- Reuse the existing title editor and add no new mode, so the editor-mode guards at their ~30 sites stay untouched. Widen `entryEditFor`'s type from `{ kind: "plan" | "bug"; position: number; title: string }` to `position: number | null`, where `null` means "filing a new entry" (and `title` is `""`). Change it in three places: `TuiKeyState.entryEditFor` (its doc comment must name the null case), the local `let entryEditFor` in `createTuiKeys`, and the `mode` parameter types of `hintLine` and `promptPrefix` in `src/ui/tui/tui-frame.ts`. Then grep `entryEditFor` across `src/ui/tui` (including `tui.tsx`, which only forwards it) to confirm no other reader does arithmetic on `position`.
- `src/ui/tui/tui-keys.ts`, the `key.ctrl && key.name === "n"` block in `handleKey`: put two branches at its top, ahead of the History-view branch.
  1. `if (entryEditFor !== null && entryEditFor.position === null)`: flip `entryEditFor.kind` (assign a new object, `{ ...entryEditFor, kind: other }`), flash `new ${kind} — Enter to file, Ctrl+N switches to ${other}, Esc cancels`, then `deps.requestRender(); return;`.
  2. `if (view === roleIds.length + 1 && <the same editor-mode guard the Ctrl+E title-edit branch uses>)`: save the prompt the way Ctrl+E does (`settlePromptRecall(promptHistory, input, cursor)` into `entryEditSavedInput`/`entryEditSavedCursor`), set `entryEditFor = { kind: "plan", position: null, title: "" }`, `input = ""`, `cursor = 0`, flash `new plan — Enter to file, Ctrl+N switches to bug, Esc cancels`, then render and return. This works with or without a selected entry.
  With any other editor open, Ctrl+N still reaches the existing transcript guard and returns, as it does today.
- The Enter handler's `else if (entryEditFor)` branch: when `target.position === null`, take a new path before the existing title-edit code.
  - A blank `input.trim()` flashes "an entry needs a title" and stays open (same wording as the edit path).
  - Otherwise: `const { role, wakeText } = OPERATOR_FILE_KINDS[target.kind]; const problem = promptLengthProblem(wakeText(collapseWhitespace(input)), role);`. A problem flashes and stays open with nothing written (the check `handleBacklogFile` runs before writing).
  - Otherwise, inside a try/catch with `flashError(err)` that stays open on a throw: `const filed = fileEntryWithBody(root, target.kind, input, ""); submitRolePromptAndWake(root, role, wakeText(filed.title)); exitEntryEdit(); flashMessage(\`filed ${target.kind}: ${filed.title} — woke ${role}\`)`.
  - Imports: `fileEntryWithBody` and `OPERATOR_FILE_KINDS` join the existing `../../backlog/backlog-write.js` import. Add `promptLengthProblem` from `../../inbox/inbox-submit.js` (merge with the existing `submitPrompt` import) and `collapseWhitespace` from `../../text/text.js` (merge with `errorMessage`). `submitRolePromptAndWake` is already imported.
- Esc (`key.name === "escape" && entryEditFor`) keeps calling `exitEntryEdit()`. Flash "new entry cancelled" when `position === null`, and keep "edit cancelled" otherwise.
- `src/ui/tui/tui-frame.ts`:
  - `promptPrefix`: when `mode.entryEditFor.position === null`, render `new ${kind}` in place of `edit ${kind} #${position}`.
  - `hintLine`: when the new-entry editor is open, show `[["Enter", \`file ${kind}\`], ["Ctrl+N", \`switch to ${other}\`], ["Esc", "cancel"], ["Ctrl+D", "quit"]]`. The edit form keeps `Enter save title`.
  - The `view.kind === "backlog"` list hint gains `["Ctrl+N", "new plan/bug"]` after `["Ctrl+E", "edit entry"]`.
- README.md "Steer the project" row: extend "the TUI's backlog pane does too, with Ctrl+X pressed twice on the selected entry (Ctrl+E edits its title)" so the parenthetical also says Ctrl+N files a new plan or bug by title and wakes its loop. Before writing, check with grep that `docs/how-it-works.md` documents none of the backlog pane's keys (it lists only the Backlog view's name today); if so, it needs no change. `src/cli/help.ts` documents no TUI keys.

**Files touched.** `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `test/tui-keys.test.ts`, `test/tui-frame.test.ts`, README.md.

**Acceptance criteria.**
- `test/tui-keys.test.ts`, using `entryEditRig` (it starts on the Backlog view):
  - Ctrl+N gives `state().entryEditFor` equal to `{ kind: "plan", position: null, title: "" }` and an empty input. Typing a title and pressing Enter appends a `### <title> (` heading under PLANS.md's `## Planned` (read back from the file), clears `entryEditFor`, flashes `filed plan: <title> — woke feature`, and queues a prompt for `feature` containing the title. Check the queue with the same queued-prompt reader the existing TUI prompt-submit tests use (find it by grep before writing).
  - Ctrl+N twice and then Enter files under BUGS.md's `## Open` and wakes `bugfix`.
  - A blank title flashes "an entry needs a title" and leaves both files unchanged with the editor still open. Esc restores the saved draft, flashes "new entry cancelled", and writes nothing.
  - Ctrl+N on a non-Backlog view (for example Activity, view 0) leaves `entryEditFor` null.
- The existing `backlog Ctrl+E …` tests pass unchanged, which shows the edit path is untouched.
- `test/tui-frame.test.ts`: `promptPrefix` with `entryEditFor: { kind: "bug", position: null, title: "" }` renders `new bug › `, and `hintLine` for it matches `/Enter file bug/` and `/Ctrl\+N switch to plan/`. The existing `assert.match(hint({ kind: "backlog" }), /↑↓ open entries · Ctrl\+X cancel entry · Ctrl\+E edit entry · Ctrl\+A answer question · …/)` breaks once the new pair is inserted. Update it to expect `Ctrl\+N new plan\/bug` between `Ctrl\+E edit entry` and `Ctrl\+A answer question`.
- `npm run test` passes.

### Clear a loop's notebook from the TUI's notebook view: Ctrl+X pressed twice, matching `tumwater role <id> --clear-notes` and the dashboard drawer's Clear (planned 2026-10-12 by plan; sibling of the landed CLI notebook write (`cmdRole`'s `--clear-notes` branch in `src/cli/cli-query-commands.ts`), the landed dashboard drawer notebook Edit/Clear (`POST /api/role-notes` in `src/gui/gui-endpoint-commands.ts`), and the landed TUI notebook view (Ctrl+N, `noteMode`/`noteCache` in `createTuiKeys`, `src/ui/tui/tui-keys.ts`). All three surfaces write through `saveRoleNote` in `src/agent/role-notes-write.ts`. Today the TUI's notebook view is read-only, so an operator who sees a stale or wrong note there has to switch to a second terminal to drop it. Replacing a notebook's text stays a CLI and dashboard job, because the TUI's prompt line holds one line and a notebook is multiline Markdown up to 4 KB. Independent of everything else: no `src/gui`, `src/ui/gui`, `src/cli`, or `src/agent` file changes; done 2026-10-12)

**Goal.** On a loop's transcript view with the notebook step shown (Ctrl+N once), Ctrl+X arms a clear and a second Ctrl+X clears that loop's notebook. The arm-then-confirm pattern matches the backlog pane's Ctrl+X cancel. The pane then re-renders with the "none yet" notebook placeholder.

**Approach.**
- `src/ui/tui/tui-keys.ts`, `createTuiKeys`: add a local `let notesClearArmed: string | null = null` (the role id a second Ctrl+X would clear) beside `cancelArmed`. Disarm it at the top of `handleKey` the same way: `const armedNotes = notesClearArmed; notesClearArmed = null;`. Update the "Every key starts disarmed" comment so it names both arms. It stays off `TuiKeyState`, because no renderer reads it.
- Add a new branch placed before the two existing `key.ctrl && key.name === "x"` branches. Guard it with `key.ctrl && key.name === "x" && noteMode` plus the same editor-mode guard those branches use (`!budgetMode && !rolePromptFor && !searchMode && !deferMode && !pauseEditMode && !queuedEditFor && !answerFor && !entryEditFor`) and the transcript range check (`view >= 1 && view <= roleIds.length`). Let `role = roleIds[view - 1]!`.
  - If `armedNotes === role`, run `flashMessage(\`${role}: ${saveRoleNote(roleNotesPath(root, role), "")}\`)`, which shows "clean: notebook cleared", the CLI's `say` wording. Then refresh the view in place: `noteCache = roleInspectMarkdown(root, role); paneScroll = 0;`. Wrap both calls in one try/catch with `flashError(err)`, as the Ctrl+N notebook entry does.
  - Otherwise set `notesClearArmed = role` and flash `press Ctrl+X again to clear ${role}'s notebook — any other key keeps it`.
  - Call `deps.requestRender(); return;` either way.
- Import `saveRoleNote` from `../../agent/role-notes-write.js` and `roleNotesPath` from `../../paths.js`. Check with grep first in case either import already exists.
- Ctrl+X on the live transcript or the change step stays inert. The new branch's `noteMode` guard keeps it out of those views, and the existing Ctrl+X branches only match the backlog and queued views.
- `src/ui/tui/tui-frame.ts`, `hintLine`: in the `view.kind === "transcript"` branch, when `view.note` is set, insert `["Ctrl+X", "clear notebook"]` right after the `Ctrl+N` pair. The live-transcript and change hints stay unchanged.
- Docs: `docs/how-it-works.md`, the TUI paragraph that describes the notebook step as "a read-only view", must say Ctrl+X pressed twice clears the notebook (as `tumwater role <id> --clear-notes` does). In README.md's "Check state" row, extend the sentence "the dashboard's loop drawer edits or clears the notebook the same way" with "and the TUI's notebook view (Ctrl+N) clears it with Ctrl+X pressed twice". `src/cli/help.ts` documents no TUI keys (grep `Ctrl+N` there first to confirm), so it needs no change.

**Files touched.** `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `test/tui-notebook.test.ts`, `test/tui-frame.test.ts`, `docs/how-it-works.md`, README.md.

**Acceptance criteria.**
- Add a test to `test/tui-notebook.test.ts`, using its `seedNote` helper and `withTui`. Seed a note for `clean`, then press Ctrl+T and Ctrl+N. The first Ctrl+X leaves the note file's content unchanged and the frame shows "press Ctrl+X again". The second Ctrl+X empties `roleNotesPath(repo, "clean")` (read back as `""`), and the frame shows "notebook cleared" and the "none yet" placeholder, the same text the existing test "a loop with no notebook shows the none-yet placeholder…" asserts.
- In the same file, a test that pressing another key between the two Ctrl+X presses (for example PgDn) disarms the clear: the note survives a following single Ctrl+X.
- In the same file, a test that Ctrl+X on the live transcript (notebook step not shown) leaves the note file unchanged.
- `test/tui-frame.test.ts`: the existing exact-string `hint({ … note: true, change: false })` assertion is updated to include `Ctrl+X clear notebook` after `Ctrl+N change`. The `note: false` transcript and `change: true` assertions stay unchanged.
- `npm run test` passes.

### Schedule or cancel one loop's wake from the TUI: Ctrl+W on a transcript opens a wake editor, matching `tumwater wake <role> --in <duration>` / `--cancel` (planned 2026-10-12 by plan; sibling of the landed CLI `tumwater wake --in`/`--cancel` (`requestWake`/`cancelWakes` in `src/operator/operator-intent.ts`), the dashboard drawer's "Wake later…" and cancel, and the TUI's per-loop Ctrl+P duration editor (`parseRolePauseInput` in `src/ui/tui/tui-input.ts`). Today the TUI's Ctrl+W can only wake the viewed loop at once (`flashMessage(requestWake(root, [role]))` in `createTuiKeys`, `src/ui/tui/tui-keys.ts`). It cannot schedule a wake or drop one, though every other surface can. Independent of the landed status-table wake marker: no `src/ui/status-render.ts` or `src/ui/badges.ts` change) — done 2026-10-12

**Goal.** On a loop's transcript view, Ctrl+W opens a one-line editor, the same way Ctrl+P does on an unpaused loop. Enter on an empty line wakes the loop now, as Ctrl+W does today. A duration (`45m`, `2h`) schedules the wake. `cancel` drops that loop's pending scheduled wakes. Esc cancels the editor.

**Approach.** Reuse the per-loop pause editor's state, so the many `!pauseEditMode` guards in `createTuiKeys` already exclude the new editor and need no edit.
1. `src/ui/tui/tui-input.ts`: add and export `parseRoleWakeInput(text): { ok: true; inMs?: number; cancel?: true } | { ok: false; error: string }`, next to `parseRolePauseInput`.
   - Trimmed `""` gives `{ ok: true }`.
   - `cancel` (case-insensitive) gives `{ ok: true, cancel: true }`.
   - Otherwise it calls `parseDurationMs`. `null` gives the error `a loop wake takes a duration like 45m or 2h, "cancel" to drop its scheduled wakes, or empty to wake now`. Over `PAUSE_FOR_MAX_MS` gives `wake is capped at 90d`, the same cap `WAKE_IN_FLAG` enforces.
   - Write the doc comment in the style of `parseRolePauseInput`'s.
2. `src/ui/tui/tui-keys.ts` (`createTuiKeys`):
   - Add `let pauseEditWake = false`, and expose `pauseEditWake: boolean` on `TuiKeysState` with a doc comment ("the per-loop editor schedules a wake (Ctrl+W) rather than a pause (Ctrl+P)"). `exitPauseEditMode` resets it to `false`.
   - The early "second Ctrl+P closes the per-loop pause editor" branch also fires on Ctrl+W, so a second press of either key closes the editor. Update its comment.
   - In the per-loop controls branch, the `else` arm that calls `requestWake` now opens the editor instead. It refuses with the same flash as Ctrl+P while `rolePromptFor || searchMode`. Otherwise it settles the prompt recall and saves the draft exactly as the Ctrl+P arm does, then sets `pauseEditMode = true`, `pauseEditRole = role`, `pauseEditWake = true`, and flashes `wake ${role}: [duration], e.g. "2h", or "cancel" (empty wakes now) — Enter to apply, Esc to cancel`.
   - In the Enter handler's `pauseEditMode` branch, when `pauseEditWake`, parse with `parseRoleWakeInput`. On error, flash and STAY in the editor. On success, call `cancelWakes(root, target)` when `cancel` is set, else `requestWake(root, [target], parsed.inMs)`. Then `exitPauseEditMode()` and flash the returned string verbatim (both cores already return the CLI's wording), inside the same try/`flashError` guard the pause arm uses. Import `cancelWakes` from `operator-intent.js`.
   - Update the "Per-loop controls" comment: Ctrl+W opens the wake editor.
   - Put `pauseEditWake` in the returned state object.
3. `src/ui/tui/tui-frame.ts`: give `hintLine` and `promptPrefix` an optional `pauseEditWake?: boolean` on their `mode` param. When it is set with `pauseEditRole`, the label reads `wake ${role}` instead of `pause ${role}`. `src/ui/tui/tui.tsx` passes `pauseEditWake: s.pauseEditWake` into `mode`. The transcript hint keeps `["Ctrl+W", "wake"]`, so the existing `test/tui-frame.test.ts` hint strings stay valid.
4. Docs: in the TUI bullet of `docs/how-it-works.md`, replace "`Ctrl+W` clears its backoff" with the editor's behaviour. In README.md's "Control the loops" row, beside "its Ctrl+P on a loop's transcript takes a duration", add that Ctrl+W takes a duration or `cancel`. Grep `docs/invariants.md` for a TUI-keys/Ctrl+W guarantee and update it if one exists.

**Files.** `src/ui/tui/tui-input.ts`, `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`, `test/tui-input.test.ts`, `test/tui-operator-keys.test.ts`, `test/tui-frame.test.ts`, `docs/how-it-works.md`, `README.md`.

**Acceptance criteria.**
- `test/tui-input.test.ts`: tests for `parseRoleWakeInput`, beside the existing `parseRolePauseInput` tests:
  - `""` and `"  "` give `{ ok: true }`.
  - `"cancel"` and `"CANCEL"` give `cancel: true`.
  - `"2h"` gives `inMs: 7_200_000`.
  - `"soon"` gives the error.
  - `"91d"` gives `wake is capped at 90d`.
- `test/tui-operator-keys.test.ts`: the existing "Ctrl+W flashes the wake confirmation and drops the wake marker for the viewed role" test breaks under this change. Rewrite it so Ctrl+W writes nothing (`wakeRequestPath(repo)` absent) until Enter on an empty line, which then flashes `/wake requested for clean/` and writes the marker. New tests:
  - Ctrl+W, `2h`, Enter: `listWakes(repo, "clean", Date.now())` holds one wake about 2h out, and the frame matches `/wake scheduled for clean/`.
  - With a wake scheduled first via `requestWake(repo, ["clean"], 3_600_000)`, Ctrl+W, `cancel`, Enter: the frame matches `/cancelled 1 scheduled wake for clean/` and `listWakes` is empty.
  - Ctrl+W, `soon`, Enter flashes the error and stays in the editor (the prompt prefix still reads `wake clean`). Esc then restores the draft typed before Ctrl+W.
  - A second Ctrl+W closes the editor without writing.
- `test/tui-frame.test.ts`: `promptPrefix`/`hintLine` with `pauseEditMode: true, pauseEditRole: "qa", pauseEditWake: true` read `wake qa`. The existing `pause qa` expectations still pass.
- Every existing Ctrl+P per-loop pause test in `test/tui-operator-keys.test.ts` still passes unchanged.
- `npm run test` passes.

### The TUI and `tumwater status` table show each loop's own pending scheduled wake (planned 2026-10-12 by plan; sibling of the landed dashboard per-loop wake display (`scheduledWakesFor`/`phaseDetail` in `src/ui/gui/gui-client-loops.ts`) and the landed `scheduledWakes` snapshot field (`src/status/status-data.ts`, filled from `scheduledWakes(root, now)` in `src/fleet/fleet-state.ts`). Today the terminal shows only the header's `wakeBadge(snap.scheduledWake, now)`, which names the EARLIEST wake. So after `wake feature --in 1h` and `wake plan --in 2h`, nothing in the TUI says plan has a wake coming, though the dashboard row and `tumwater wake --list` both do. Render-only: no snapshot, payload, `src/ui/gui`, or `src/operator` change) — done 2026-10-12

**Goal.** In the status table shared by `tumwater status` and the TUI (`renderStatusSpans` in `src/ui/status-render.ts`), each loop that a future scheduled wake names gets a short marker on its state cell, the way a loop with queued prompts gets `p:N`.

**Approach.**
1. `src/ui/badges.ts`: beside `wakeBadge`, add and export `loopWakeMarker(wakes: { roles: string[]; atMs: number }[] | undefined, role: string, instanceOf: string | undefined, now: number): string`. It takes the earliest wake with `atMs > now` whose `roles` include `role`, or `instanceOf` when that is set. This is the same match rule as the GUI's `scheduledWakesFor`; say so in the doc comment, since the GUI keeps its own JS copy. It returns ` · wake in ${humanSeconds(secondsUntil(atMs, now))}` for that wake, and `""` when no wake matches. Do not assume `wakes` is sorted: pick the minimum `atMs`.
2. `src/ui/status-render.ts`, in the `rows` map of `renderStatusSpans`: append `{ text: loopWakeMarker(snap.scheduledWakes, s.role, s.instanceOf, now), tone: "blue" }` to the state cell, after the `roleQueued(s.role)` span, using the render's single `now`. Skip the span when the text is empty, so a row without a wake keeps its current spans exactly. Extend the comment above `roleQueued` to mention the wake marker. It goes last so the work item and phase survive clipping ahead of it. The header's `wakeBadge` stays as is, and the totals row gets no marker.
3. `docs/invariants.md`: no wake section exists (checked with grep), so no register change.

**Files.** `src/ui/badges.ts`, `src/ui/status-render.ts`, `test/badges.test.ts`, `test/status-render.test.ts`.

**Acceptance criteria.**
- `test/badges.test.ts`: a new test beside "wakeBadge names a pending scheduled wake and is empty otherwise" covers `loopWakeMarker` with `now` fixed:
  - `[{roles:["feature"], atMs: now+1h}, {roles:["plan"], atMs: now+2h}]` gives `" · wake in 1h"` for `feature` and `" · wake in 2h"` for `plan`, and `""` for `qa`.
  - An instance (`role "feature-2"`, `instanceOf "feature"`) matches the `feature` wake.
  - A list given latest-first still yields the earliest match.
  - A wake with `atMs <= now` and an `undefined` list both give `""`.
- `test/status-render.test.ts`: a new test next to "a loop with queued prompts carries a p:N marker on its state cell". It builds the snapshot with `snapshotWith` for loops `clean` and `dry`, then sets `snap.scheduledWakes = [{ roles: ["dry"], atMs: Date.now() + 2 * 3_600_000 }]`.
  - The `dry` row matches `/wake in 2h/`, and the `clean` row and the totals row do not match `/wake in/`.
  - Leave `snap.scheduledWake` undefined, so the header badge does not supply the text.
- The existing "a loop with queued prompts carries a p:N marker on its state cell" test and every other `test/status-render*.test.ts`, `test/status-header.test.ts` and `test/tui-frame.test.ts` test still pass. Rows without a wake render the same spans as before.
- `npm run test` passes.

### The dashboard's loop rows and drawer see every pending scheduled wake, not just the earliest (planned 2026-10-12 by plan; sibling of the landed `tumwater wake --list` (`listWakes`/`renderWakeList` in `src/operator/operator-intent.ts`), the landed dashboard per-loop wake display (`scheduledWakeFor`/`phaseDetail` in `src/ui/gui/gui-client-loops.ts`) and drawer "Cancel scheduled wake" (`gui-client-drawer.ts`, over `POST /api/wake-cancel`). Today the status payload carries only the earliest pending wake (`scheduledWake` in `src/status/status-data.ts` → `scheduledWake(root, now)` in `src/fleet/fleet-state.ts` = `pendingScheduledWakes(root, now)[0]`). So after `wake feature --in 1h` and `wake plan --in 2h`, plan's row shows no "operator wake in 2h" and its drawer offers no cancel, though `tumwater wake --list` shows both. The comment above `scheduledWakeFor` records this gap. Read-only payload addition plus a client change; no new route or action, and no `src/ui/tui` file) — done 2026-10-12

**Goal.** Every loop that a pending scheduled wake names shows that wake on its dashboard row and can cancel it from its drawer, whichever wake is earliest.

**Approach.**
1. `src/fleet/fleet-state.ts`: export `scheduledWakes(root, now)`, returning `pendingScheduledWakes(root, now)` (earliest first, same pure-reader doc). Re-express `scheduledWake` as `scheduledWakes(root, now)[0]`.
2. `src/status/status-data.ts`: add `scheduledWakes?: { roles: string[]; atMs: number }[]` to the snapshot type beside `scheduledWake`, with a doc comment. Absent when no wake is pending. In the snapshot builder, read the list ONCE (`const wakes = scheduledWakes(root, now)`) and set `scheduledWake: wakes[0]` and `scheduledWakes: wakes.length > 0 ? wakes : undefined`, so the two fields cannot disagree.
3. `src/ui/status-payload.ts`: ship `scheduledWakes: snap.scheduledWakes` beside `scheduledWake` (same omit-undefined idiom, one-line comment). `scheduledWake` stays as is for `status --json` consumers and `wakeBadge` (`src/ui/status-render.ts`).
4. `src/ui/gui/gui-client-loops.ts`: add `scheduledWakesFor(l, d)`. It returns the future wakes (`atMs > Date.now()`) naming `l.role`, or `l.instanceOf` when set, earliest first. It reads `d.scheduledWakes`, falling back to `[d.scheduledWake]` when the list is absent, so an older server's payload still works. `scheduledWakeFor(l, d)` becomes `scheduledWakesFor(l, d)[0] || null`, so `phaseDetail` shows the earliest wake naming THIS loop. Rewrite the comment above it: the earliest-only caveat no longer holds.
5. `src/ui/gui/gui-client-drawer.ts`: the cancel button condition becomes `scheduledWakesFor(l, d).some((w) => w.roles.includes(l.role))`. Keep the exact-id comment. With a list, an instance row whose earliest match names only its base role can still have a later wake that names its own id.

**Files.** `src/fleet/fleet-state.ts`, `src/status/status-data.ts`, `src/ui/status-payload.ts`, `src/ui/gui/gui-client-loops.ts`, `src/ui/gui/gui-client-drawer.ts`, tests below.

**Acceptance criteria.**
- `test/fleet-state.test.ts`: a new test writes two scheduled wakes and checks that `scheduledWakes` returns both, earliest first, with `scheduledWake` equal to its first element. The existing "scheduledWake reads the earliest pending timed wake and nothing else, leaving the markers" test still passes unchanged.
- `test/status-payload.test.ts`: extend "status payload and header show a pending scheduled wake only while one stands" (or add a sibling test). With no marker, `scheduledWakes` is absent. After `requestWake(repo, ["feature"], 3_600_000)` and `requestWake(repo, ["plan"], 7_200_000)`, `scheduledWakes` maps to roles `[["feature"], ["plan"]]` and `scheduledWake.roles` is `["feature"]`.
- `test/gui-client-loops.test.ts`: a new test, alongside "a scheduled operator wake adds a second-line phrase to the rows it targets". The payload is `scheduledWakes: [{roles:["feature"], atMs: +1h}, {roles:["plan"], atMs: +2h}]`. The plan row's `phaseDetail` ends with "operator wake in 2h", the feature row's with "operator wake in 1h", and a qa row has no operator-wake phrase. The existing test still passes: it sends only `scheduledWake`, which exercises the fallback.
- `test/gui-client-drawer.test.ts`: the scope stub that mirrors `scheduledWakeFor` gains a `scheduledWakesFor` mirror, or the test loads the real helper. "an idle loop's drawer offers Cancel scheduled wake only while a future wake names it" gains two cases: the button shows for a loop named only by the SECOND entry of `scheduledWakes`, and it shows for an instance row (`instanceOf: "base"`) when one wake names `base` and a later one names the instance id.
- `npm run test` passes.


### List every pending scheduled wake: `tumwater wake --list [--role <id>] [--json]` (planned 2026-10-12 by plan; sibling of the landed `tumwater wake --cancel` and dashboard wake-cancel; independent of the TUI Ctrl+P plan); done 2026-10-12 by feature

**Goal.** Each `wake --in` writes its own file under `scheduledWakeDir`, and several can be pending at once, but `tumwater status` and the dashboard show only the earliest (`fleet-state.ts` returns `pendingScheduledWakes(root, now)[0]`). So an operator can't see what `wake --cancel` would drop. `wake --list` prints every pending scheduled wake, earliest first. With `--role <id>` it prints only the wakes naming that loop, and with `--json` it prints them as JSON for scripts. It is a read-only view: it writes, deletes, and wakes nothing.

**Approach.**
1. *Flag spec.* In `src/cli/cli-flag-specs.ts`, beside `WAKE_CANCEL_FLAG`, add `export const WAKE_LIST_FLAG: FlagSpec = { names: ["--list"] };` with a one-line doc comment. In `src/cli/cli-marker-commands.ts`, extend `perCommandFlags.wake` to `[ROLE_FLAG, WAKE_IN_FLAG, WAKE_CANCEL_FLAG, WAKE_LIST_FLAG, JSON_FLAG]` (import both). Update the comment above `perCommandFlags` that lists which flags `wake` alone accepts.
2. *Core.* In `src/operator/operator-intent.ts`, beside `cancelWakes`, add `export function listWakes(root: string, role: string | undefined, now: number): { roles: string[]; atMs: number }[]`. It returns `pendingScheduledWakes(root, now)`, filtered to the entries whose `roles` include `role` when `role` is given. Entries keep their full `roles` list, so a wake shared with other loops still names them all. Also add `export function renderWakeList(wakes: { roles: string[]; atMs: number }[], now: number, role?: string): string`. For an empty list it returns `no scheduled wake pending` plus ` for <role>` when `role` is set, the same wording `cancelWakes` uses. Otherwise it returns one line per wake, numbered from 1: `` `${i}. in ${humanSeconds(secondsUntil(w.atMs, now))} — ${w.roles.join(", ")}` ``, using `humanSeconds` and `secondsUntil` from `src/text/datetime.ts`, which `wakeBadge` uses too. The lines are joined with `\n`.
3. *Command.* In `cmdWake` (`src/operator/operator-commands.ts`), before the `--cancel` branch: when `args.includes("--list")`, fail with `wake --list cannot be combined with --in or --cancel` if either flag is present. Otherwise read `const now = Date.now()` once, resolve `namedRole(root, args)`, and call `listWakes`. With `--json`, print `JSON.stringify(wakes)` (`[]` when empty). Without it, `say(renderWakeList(...))`, then return. Outside `--list`, `--json` fails with `wake --json requires --list`. Extend `cmdWake`'s doc comment with the `--list` form.
4. *Help/docs.* In `src/cli/help.ts`, change the wake entry's usage to `tumwater wake [--role <id>] [--in <dur> | --cancel | --list [--json]]` and add to its description: "--list shows every pending scheduled wake, earliest first (--json for scripts)". In README.md's "Control the loops" row, after "drops the pending scheduled wakes (or that loop's share of them)", add ", `tumwater wake --list [--role <id>] [--json]` lists them". Do not touch `FREEFORM_VALUED_FLAGS`, because `--list` takes no value.

**Files touched.** `src/cli/cli-flag-specs.ts`, `src/cli/cli-marker-commands.ts`, `src/operator/operator-intent.ts`, `src/operator/operator-commands.ts`, `src/cli/help.ts`, `README.md`, `test/cli-operators.test.ts`, and `test/operator-requests.test.ts` (or whichever test file already imports from `operator-intent.ts`; check with grep).

**Acceptance criteria.**
- Unit tests for `renderWakeList`: an empty list gives `no scheduled wake pending`, and with role `qa` gives `no scheduled wake pending for qa`. Two wakes at `now + 45m` (`["qa"]`) and `now + 2h` (`["feature", "qa"]`) render as `1. in 45m — qa\n2. in 2h — feature, qa`.
- Unit test for `listWakes`: with the two wakes above plus a `["clean"]` one, `role: "feature"` returns only the 2h entry with `roles` `["feature", "qa"]`. Without a role it returns all three, earliest first.
- CLI test in `test/cli-operators.test.ts`, beside "wake --cancel drops scheduled wakes without writing a marker": after `wake --role qa --in 45m` and `wake --role feature --in 2h`, `wake --list` exits 0 and its stdout matches `/^1\. in 4[45]m — qa$/m` and `/^2\. in (2h|1h59m|1h) — feature$/m`. Before writing that regex, check `humanSeconds`'s output for just under 2h and loosen it accordingly. `wake --list --role qa` lists only the qa wake. `wake --list --json` parses as a two-element array with `roles` and `atMs`. `readScheduledWakes(repo)` still has 2 entries afterwards, and `wakeRequestPath(repo)` does not exist.
- CLI test: with nothing pending, `wake --list` prints `no scheduled wake pending` and `wake --list --json` prints `[]`. `wake --list --cancel` and `wake --list --in 5m` exit 1 with `wake --list cannot be combined with --in or --cancel`. `wake --json` exits 1 with `wake --json requires --list`. `reset-counters --list` is still rejected as an unknown argument.
- `npm run test` passes.

### Give one loop a timed pause from the TUI: Ctrl+P on an unpaused loop takes a duration, matching `tumwater pause --role <id> --for <duration>` (planned 2026-10-12 by plan; sibling of the landed TUI Ctrl+F fleet pause editor (`pauseEditMode`, `exitPauseEditMode`, `parsePauseInput` in `src/ui/tui/tui-input.ts`) and the landed CLI per-role timed pause (`cmdPause`'s `--role` branch in `src/operator/operator-commands.ts` over `pauseRole(root, role, untilMs)` in `src/fleet/fleet-state.ts` and `rolePauseMessage(root, role, changed, timed, now)` in `src/operator/operator-intent.ts`) and the dashboard's per-loop `pause-for` chooser. Today the TUI's Ctrl+P on a loop's transcript only toggles a standing pause, so "hold feature for 2h" means a second terminal. Independent of the waiting "Cancel pending scheduled wakes from the dashboard" plan: this plan touches no `src/gui`, `src/ui/gui`, or `src/operator` file); done 2026-10-12 by feature

**Goal.** On a loop's transcript view, Ctrl+P on an unpaused loop opens the same one-line pause editor Ctrl+F opens, but for that loop and taking only a duration: Enter on an empty line pauses until resumed, Enter on `2h` pauses for two hours and auto-resumes, Esc cancels. Ctrl+P on a paused loop still resumes at once. The flash is the CLI's wording, so the surfaces cannot drift.

**Approach.**
1. *Parser.* In `src/ui/tui/tui-input.ts`, beside `parsePauseInput`, add `parseRolePauseInput(text): { ok: true; forMs?: number } | { ok: false; error: string }`. Trimmed empty → `{ ok: true }`. A `parseDurationMs` value → `{ ok: true, forMs }`, or `{ ok: false, error: "pause is capped at 90d" }` over `PAUSE_FOR_MAX_MS` (the same wording `parsePauseInput` uses). Anything else (including a duration followed by more words) → `{ ok: false, error: "a loop pause takes only a duration like 45m or 2h (empty pauses until resumed) — reasons are fleet-wide, use Ctrl+F" }`. Per-role pauses carry no reason on purpose (`cmdPause` fails `--reason` with `--role`), so the editor refuses one instead of dropping it.
2. *State.* In `createTuiKeys` (`src/ui/tui/tui-keys.ts`), add `let pauseEditRole: string | null = null` next to `pauseEditMode`. The per-loop editor is `pauseEditMode === true` with `pauseEditRole` set, so every existing `!pauseEditMode` guard keeps both editors exclusive with the others without being touched. `exitPauseEditMode` also sets `pauseEditRole = null`. Expose `pauseEditRole` in `TuiKeysState` (doc comment: "the loop the pause editor pauses, null for the fleet editor (Ctrl+F)") and in the state object `createTuiKeys` returns.
3. *Ctrl+P.* In the per-loop controls block's `key.name === "p"` branch: when `pausedRoles(root).includes(role)`, resume at once as today (`resumeRole` + `roleResumeMessage`). Otherwise, if `rolePromptFor` or `searchMode` holds the prompt line, flash `"finish or cancel the role prompt first (Esc cancels)"` / `"finish or cancel the search first (Esc cancels)"` and write nothing (the outer guard lets Ctrl+P through in those modes today). Else open the editor the way the Ctrl+F branch does: `settlePromptRecall`, save into `pauseSavedInput`/`pauseSavedCursor`, set `pauseEditMode = true`, `pauseEditRole = role`, blank the line, and flash `pause <role>: [duration], e.g. "2h" (empty pauses until resumed) — Enter to pause, Esc to cancel`. Add a branch before the per-loop block: Ctrl+P while `pauseEditRole !== null` calls `exitPauseEditMode()` and renders, mirroring Ctrl+F's second press. Ctrl+F's existing `if (pauseEditMode) exitPauseEditMode()` also closes the per-loop editor; leave it.
4. *Enter.* In the Enter handler's `else if (pauseEditMode)` branch, when `pauseEditRole !== null` parse with `parseRolePauseInput`. Invalid → flash the error and stay in the editor. Valid → `const at = now(); const until = forMs === undefined ? undefined : at + forMs; const changed = pauseRole(root, role, until);`, `exitPauseEditMode()`, then `flashMessage(rolePauseMessage(root, role, changed, forMs === undefined ? undefined : { ms: forMs, untilMs: until! }, at))`, inside the same try/`flashError` as the fleet path. The fleet path (`pauseEditRole === null`) is unchanged.
5. *Frame.* In `src/ui/tui/tui-frame.ts`, add optional `pauseEditRole?: string | null` to the `mode` parameter of `hintLine` and `promptPrefix`. `promptPrefix` shows `pause <role> › ` when it is set (else the existing `pause › `); `hintLine`'s pause-edit keys read `["Enter", "pause <role>"]` when set (else `["Enter", "pause"]`). Pass `pauseEditRole: s.pauseEditRole` in `src/ui/tui/tui.tsx`'s `mode` object. The transcript hint keeps `Ctrl+P pause/resume`.
6. *Docs.* README.md's "Control the loops" row: after "the TUI's Ctrl+F takes a duration and reason too", add "and its Ctrl+P on a loop's transcript takes a duration". `docs/how-it-works.md`'s transcript-controls bullet ("`Ctrl+P` toggles its pause"): say Ctrl+P on an unpaused loop opens a duration editor (empty pauses until resumed, Esc cancels) through the same `pauseRole` marker `tumwater pause --role --for` writes, and on a paused loop resumes at once. Note in that bullet that the per-role deadline is the paused-roles marker's one shared field, as with the CLI. `docs/invariants.md` names no TUI pause guarantee, so it needs no entry. Update the header comment of `test/tui-operator-keys.test.ts` if it describes Ctrl+P as a toggle.

**Files touched.** `src/ui/tui/tui-input.ts`, `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`, `README.md`, `docs/how-it-works.md`, and tests in `test/tui-operator-keys.test.ts`, `test/tui-frame.test.ts`, and `test/tui-input.test.ts` (beside the `parsePauseInput` tests).

**Acceptance criteria.**
- `parseRolePauseInput` unit tests: `""` and `"  "` → `{ ok: true }`; `"2h"` → `forMs` 7 200 000; `"91d"` → the 90d cap error; `"later"` and `"2h deploy"` → the duration-only error.
- `test/tui-operator-keys.test.ts`'s "Ctrl+P toggles the viewed loop's pause marker and flashes the CLI's wording" and "Ctrl+P's resume flash carries the fleet-pause interplay note while the fleet is paused" press Enter after the opening Ctrl+P (the editor writes nothing before Enter: `pausedRoles(repo)` is `[]` until then) and otherwise keep their assertions.
- A new test: on the transcript view, Ctrl+P, type `2h`, Enter → `pausedRoles(repo)` is `["clean"]`, the paused-roles marker (`pausedRolesPath`) carries an `until` about two hours ahead, and the frame shows `role clean paused for 2h`.
- A new test: Ctrl+P, type `2h`, Esc → no role paused and the prior draft is back on the prompt line; Ctrl+P, type `later`, Enter → no role paused, the duration-only error is flashed, and the line still starts `pause clean ›`.
- A new test: in Ctrl+R role-prompt mode, Ctrl+P on an unpaused loop pauses nothing and flashes the role-prompt refusal.
- "the per-loop keys are inert outside transcript views, in budget mode, and on failure flash an error" keeps its inertness assertions unchanged. Its failure step (the paused-roles path made a directory) now opens the editor first, so it presses Enter after Ctrl+P and still sees `error: ` in the frame, with the TUI alive. The Ctrl+F tests pass unchanged.
- `test/tui-frame.test.ts`: `promptPrefix`/`hintLine` with `pauseEditMode: true, pauseEditRole: "qa"` render `pause qa › ` and `Enter pause qa`; without `pauseEditRole` they render as today.
- `npm run test` passes.

### Cancel pending scheduled wakes from the dashboard, matching `tumwater wake --cancel [--role <id>]` (planned 2026-10-12 by plan; sibling of the landed CLI `tumwater wake --cancel` (`cancelScheduledWakes` in `src/operator/operator-requests.ts`, called from `cmdWake`'s `--cancel` branch in `src/operator/operator-commands.ts`) and the landed dashboard scheduling controls: the Loops card's "Wake later" menu (`wake-later` region of `src/ui/gui/gui-client-loops.ts`) and the loop drawer's "Wake later…" chooser (`wake-in` in `rowAction`, `ROLE_WAKE_CHOICES`). Today the dashboard can schedule a wake and shows it ("operator wake in 1h" from `phaseDetail`) but cannot take it back, so an operator who scheduled the wrong one has to switch to the CLI. This plan touches no `src/ui/tui` file; done 2026-10-12)

**Goal.** The dashboard drops pending scheduled wakes through the same core the CLI uses, both fleet-wide and for one loop, and reports the same text the CLI prints.

**Approach.**
1. *Shared message core.* Add `cancelWakes(root: string, role?: string): string` to `src/operator/operator-intent.ts`, beside `requestWake`. It calls `cancelScheduledWakes(root, role)` (import from `./operator-requests.js`; that module does not import operator-intent, so there is no cycle) and returns the text `cmdWake` now builds inline: `cancelled <n> scheduled wake(s)[ for <role>]`, or `no scheduled wake pending[ for <role>]`. Change `cmdWake`'s `--cancel` branch to `say(cancelWakes(root, role ?? undefined))` and drop its inline formatting and its now-unused `cancelScheduledWakes` import. The CLI output stays the same: the existing test "wake --cancel drops scheduled wakes without writing a marker" in `test/cli-operators.test.ts` must pass unchanged.
2. *Route.* Add `handleWakeCancel` to `src/gui/gui-endpoint-commands.ts`, after `handleWake`. It reads the body with `readRoleBody(req, res, '{"role": "feature"}', root, true)`. A missing role means every pending wake, so it calls `cancelWakes(root)`, not a per-role loop. A given role calls `cancelWakes(root, role)`. It answers `sendJson(res, 200, { ok: true, message })`. Register `"POST /api/wake-cancel"` in `src/gui/gui-server.ts`'s route table next to `"POST /api/wake"`. `readRoleBody`'s doc comment lists its call sites ("Exactly six call sites — …"); update the count and add `handleWakeCancel` to the list.
3. *Fleet control.* In the `wake-later` region of `gui-client-loops.ts`, end `openWakeLaterMenu`'s html with one more menu item, `<button … class='menu-item' role='menuitem' data-wakecancel='1'>` with the label "Cancel scheduled wakes". It is always shown, because the server's reply already covers the case where nothing is pending. Add an `onClick` branch: `t.closest("[data-wakecancel]")` → `closeMenus()` and `postAction("/api/wake-cancel", {}, (d) => d && typeof d.message === "string" ? d.message : "scheduled wakes cancelled")`. Check it before the `[data-wakein]` branch.
4. *Per-loop control.* In `src/ui/gui/gui-client-drawer.ts`'s loop actions (the non-live branch that adds the "Wake now" and "Wake later…" buttons), append `btn("wake-cancel", "x", "Cancel scheduled wake")` (`x` is the existing glyph in `src/ui/gui/gui-icons.ts`) when the status payload's `d.scheduledWake` names this loop. Use the same test `phaseDetail` uses: `w.atMs > Date.now()`, and `w.roles` includes `l.role` or `l.instanceOf`. Pull that test out of `phaseDetail` into a small `scheduledWakeFor(l, d)` helper in the `loops-table` region and call it from both places, so the button and the "operator wake in …" note cannot disagree. In `rowAction`, map `action === "wake-cancel"` to path `/api/wake-cancel` with body `{ role }` and the fallback message `role + ": scheduled wake cancelled"`. Before posting, clear any open chooser, the same way other actions clear `roleChooser`. The drawer button additionally requires `w.roles` to include `l.role` exactly (the cancel matches exact ids, so an instance named only via its base role would cancel nothing). Limitation: `scheduledWake` in the payload holds only the earliest pending wake, so a loop named only by a later wake shows no button. The fleet menu item still cancels that wake. Record this in the helper's comment and leave the payload unchanged.
5. *Docs.* In README.md's "Control the loops" row, after the `wake --cancel` clause, say that the dashboard's Wake later menu and the loop drawer cancel pending wakes the same way. `docs/invariants.md` names no `/api/wake` guarantee, so it needs no entry.

**Files touched.** `src/operator/operator-intent.ts`, `src/operator/operator-commands.ts`, `src/gui/gui-endpoint-commands.ts`, `src/gui/gui-server.ts`, `src/ui/gui/gui-client-loops.ts`, `src/ui/gui/gui-client-drawer.ts`, `README.md`, and tests in `test/operator-intent.test.ts`, `test/gui-operator.test.ts`, `test/gui-client.test.ts`, and `test/gui-client-drawer.test.ts`.

**Acceptance criteria.**
- A unit test of `cancelWakes` shows four results: two pending files and no role → `cancelled 2 scheduled wakes`; no files → `no scheduled wake pending`; a role named only by a shared file → `cancelled 1 scheduled wake for qa`, with the file rewritten without `qa`; a role named by nothing → `no scheduled wake pending for qa`.
- `test/gui-operator.test.ts` gets a new test, "POST /api/wake-cancel drops scheduled wakes like `tumwater wake --cancel`". It schedules two wakes through `POST /api/wake` with `inSeconds` (one `{ role: "feature" }`, one fleet-wide), then checks three things. `{ role: "feature" }` answers 200 and leaves the fleet-wide file standing without `feature` (via `readScheduledWakes`). `{}` answers 200 with `cancelled 1 scheduled wake` and leaves `scheduledWakeDir` with no `.json` files. `{ role: "nope" }` answers 400 and changes no files. No immediate marker (`wakeRequestPath`) is written at any point.
- `test/gui-client.test.ts`'s "Wake later opens a four-choice menu and a choice posts inSeconds" still passes: the four `data-wakein=` items are unchanged. A new test, or an extension of it, shows that the menu holds one `data-wakecancel` item and that clicking it posts `{ path: "/api/wake-cancel", body: {} }` and closes the menu.
- `rowAction("wake-cancel", "docs")` posts `/api/wake-cancel` with `{ role: "docs" }`, covered in the existing rowAction test ("a loop's controls post explicit states, …") or beside it.
- `test/gui-client-drawer.test.ts`: an idle loop's drawer shows `data-action='wake-cancel'` when the status's `scheduledWake` names the loop with a future `atMs`. It shows no such button when `scheduledWake` is absent, names another loop, or is past due.
- `test/gui-client-loops.test.ts`'s `phaseDetail` assertions ("operator wake in 1h") pass unchanged after the helper is extracted.
- `npm run test` passes.


### Cancel pending scheduled wakes with `tumwater wake --cancel [--role <id>]` (planned 2026-10-12 by plan; sibling of the landed `tumwater wake --in` (`requestWake` in `src/operator/operator-intent.ts` writes one file per scheduled wake under `scheduledWakeDir`, `.tumwater/wakes/`), the landed per-file consumer (`consumeWakeRequest` in `src/operator/operator-requests.ts`), and the landed status display (`pendingScheduledWakes`, `scheduledWake` in `src/fleet/fleet-state.ts`, `wakeBadge`). Independent of the waiting TUI Ctrl+F pause plan: this plan touches no `src/ui` file. A dashboard "cancel scheduled wake" control is a separate, later sibling that reuses this plan's core; done 2026-10-12)

**Goal.** Once `wake --in 2h` is scheduled, nothing can retract it. `tumwater status` shows the pending wake, but the only way to drop it is to delete files under `.tumwater/` by hand, which loops and operators are told never to touch. Add `tumwater wake --cancel`: it removes every pending scheduled wake. `--role <id>` narrows the cancel to that one loop.

**Approach.**
1. `src/operator/operator-requests.ts`: add `export function cancelScheduledWakes(root: string, role?: string): number`, next to `pendingScheduledWakes`. It reuses the file's private `scheduledWakeFiles`, `wakeNotDue`, and `requestedRoles`. It only touches files whose deadline still lies ahead (`wakeNotDue(file)` true). Due and corrupt files stay the consumer's to apply.
   - Without `role`: `removeQuiet` each pending file. Each counts as one.
   - With `role`: skip files whose roles do not include it. If the role is the file's only role, `removeQuiet` the file. Otherwise rewrite the same path with `writeJsonAtomic` (from `src/files/json-files.ts`), keeping `at` and `notBeforeMs` and dropping the role from `roles`. Each touched file counts as one.
   - Return the count.
   - Update `consumeWakeRequest`'s comment "writers only create files and only this consumer deletes them". The new wording: a cancel also deletes or rewrites files, but only files whose deadline is still ahead, so it never races the consumer's apply of a due file. The window that is left is a deadline crossing between the cancel's read and its write. The worst case there is one extra wake for the remaining roles, the same as a wake that was never cancelled.
2. `src/cli/cli-flag-specs.ts`: add `export const WAKE_CANCEL_FLAG: FlagSpec = { names: ["--cancel"] }`, beside `WAKE_IN_FLAG`, shaped like `DRY_RUN_FLAG`. `src/cli/cli-marker-commands.ts`: add it to `perCommandFlags.wake`, and add `--cancel` to the comment above `perCommandFlags` that lists the per-command flags.
3. `src/operator/operator-commands.ts` `cmdWake`: when `args.includes("--cancel")` is true:
   - If `--in` is also given, `fail("wake --cancel and --in cannot be combined")` before any file work.
   - Otherwise resolve the role with `namedRole(root, args)`, which validates the id as other commands do, and call `cancelScheduledWakes`.
   - Print one line through `say`. With a count above zero: `cancelled N scheduled wake(s)` (singular `wake` for 1), plus ` for <role>` when a role was named. With a count of zero: `no scheduled wake pending` (plus ` for <role>`). The exit is 0 either way, so the command is idempotent.
   - Return without writing `wake.json` and without touching loop state. Cancelling is not a wake.
   - No live fleet is required. The files are the whole state, and the next poll simply finds fewer of them.
   - Update `cmdWake`'s docstring signature line to `[--in <duration> | --cancel]`.
4. `src/cli/help.ts`: change the `tumwater wake` usage line to `tumwater wake [--role <id>] [--in <dur> | --cancel]`, and extend its description with "; --cancel drops pending scheduled wakes".
5. README "Control the loops" row: after the sentence saying later wakes do not cancel a scheduled wake, add "`tumwater wake --cancel [--role <id>]` drops the pending scheduled wakes (or that loop's share of them)".

**Files touched.** `src/operator/operator-requests.ts`, `src/operator/operator-commands.ts`, `src/cli/cli-flag-specs.ts`, `src/cli/cli-marker-commands.ts`, `src/cli/help.ts`, `README.md`, `test/operator-requests.test.ts`, `test/cli-operators.test.ts`.

**Acceptance criteria.**
- `test/operator-requests.test.ts`, new tests on `cancelScheduledWakes`:
  - Two pending wake files plus one past-deadline file, no role: the call returns 2, removes the two pending files, and leaves the past-deadline file in place.
  - A role cancel: a file naming `["qa"]` is removed. A file naming `["qa","feature"]` is rewritten with `roles: ["feature"]` and the same `notBeforeMs`. A file naming `["feature"]` is untouched. The call returns 2.
  - A missing `scheduledWakeDir` returns 0 and does not throw.
- `test/cli-operators.test.ts`, in the wake section:
  - `wake --role qa --in 45m`, then `wake --cancel`. The second command exits 0, prints `cancelled 1 scheduled wake`, and leaves `readScheduledWakes(repo)` empty. A repeat prints `no scheduled wake pending`.
  - `wake --cancel --role qa` prints `... for qa`.
  - `wake --cancel --in 5m` exits 1 with the combine error, and no marker is written or removed.
  - `pause --cancel` exits 1 with `unknown argument: --cancel`.
  - `wake --cancel` does not create `wakeRequestPath(repo)`.
- `npm run test` passes.

### Pause the fleet for a duration and with a reason from the TUI's Ctrl+F, matching `tumwater pause --for <duration> --reason <text>` (planned 2026-10-12 by plan; sibling of the landed CLI `tumwater pause --for/--reason` (`cmdPause` in `src/operator/operator-commands.ts`) and the landed dashboard pause menu with reason (`handlePause` over `POST /api/pause`, which reads `forSeconds` and `reason` and calls `pauseFleet(root, untilMs, reason)`). Independent of the waiting dashboard notebook plan: this plan touches only `src/ui/tui/`, its tests, and docs, with no `src/gui` or `src/ui/gui` file. A TUI per-loop timed pause (Ctrl+P) is a separate, later sibling; done 2026-10-12)

**Goal.** In the TUI, Ctrl+F pauses the fleet with no deadline and no note (`pauseFleet(root)` in `createTuiKeys`, `src/ui/tui/tui-keys.ts`). An operator who pauses from the terminal cannot schedule an auto-resume, and cannot leave the "why" that `status`, the dashboard, and the TUI's own fleet alert already show. Make Ctrl+F on an unpaused fleet open a one-line pause editor on the prompt line. Ctrl+F on a paused fleet keeps resuming at once, as it does today.

**Approach.** These are design decisions, not open questions for the implementer.
1. `src/ui/tui/tui-input.ts`: add a pure `parsePauseInput(text)` beside `parseDeferInput`. It returns `{ ok: true; forMs?: number; reason?: string }` or `{ ok: false; error: string }`:
   - Trim the text. Empty means a standing pause with no reason.
   - If the first whitespace-separated word parses with `parseDurationMs` (`src/cli/cli-args.ts`), it is the duration (`forMs`), and the rest, trimmed, is the reason. Otherwise the whole text is the reason and there is no deadline.
   - A duration over `PAUSE_FOR_MAX_MS` returns `{ ok: false, error: "pause is capped at 90d" }`. This matches the cap `pause --for` and `/api/pause` enforce.
   - Return `forMs` (the duration), not an epoch. The caller computes `now() + forMs`, so the function stays pure.
   - Do not normalize the reason here. `pauseFleet` already folds and caps it through `normalizePauseReason`.
2. `src/ui/tui/tui-keys.ts`:
   - Add a `pauseEditMode` boolean with saved-draft fields (`pauseSavedInput`/`pauseSavedCursor`) and an `exitPauseEditMode()` that restores the draft. Model these on `deferMode`/`exitDeferMode`, including the `settlePromptRecall` settle on entry.
   - Expose `pauseEditMode` on the exported state interface beside `deferMode`.
   - Rework the Ctrl+F branch:
     - It reads `isFleetPaused(root)` fresh. A paused fleet resumes exactly as it does now.
     - An unpaused fleet enters pause-edit mode with an empty line and flashes `pause the fleet: [duration] [reason], e.g. "2h deploy freeze" (empty pauses until resumed) — Enter to pause, Esc to cancel`.
     - Ctrl+F pressed again while in pause-edit mode leaves it, like Ctrl+L does for defer.
   - Enter in pause-edit mode calls `parsePauseInput`:
     - On an error, flash it and stay in the editor.
     - Otherwise call `pauseFleet(root, forMs === undefined ? undefined : now() + forMs, reason)`, leave the editor, and flash:
       - `fleetPausePhrase()` when the call changed state, with ` for <durationLabel(forMs)>` appended when timed and `: <reason>` when a reason was given;
       - `fleetPausePhrase()` with the same ` for …` suffix when `pauseFleet` returns false on a timed call, because it overwrote the deadline;
       - `"fleet is already paused"` when it returns false without a deadline.
     - Wrap the write in try/catch with `flashError`, as the current branch does.
   - Esc leaves the editor without writing. Ctrl+T leaves it the same way the other editors are left on a view change.
   - Add `pauseEditMode` to every mutual-exclusion guard that lists `deferMode`, and add a `"finish or cancel the pause first (Esc cancels)"` arm to the Ctrl+B and Ctrl+L flash chains. Check them all with `grep -n deferMode src/ui/tui/tui-keys.ts`.
3. `src/ui/tui/tui-frame.ts`:
   - In `hintLine`, pause-edit mode shows `[["Enter", "pause"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]`.
   - `promptPrefix` shows a `pause` brand span.
   - Add an optional `pauseEditMode?: boolean` to both functions' `mode` parameter types, so existing callers and tests keep compiling.
   - Pass it from the `mode` object in `src/ui/tui/tui.tsx`.
   - The idle hint's `["Ctrl+F", "pause fleet"]` stays as it is.
4. Docs:
   - Update the `Ctrl+F` sentence in `docs/how-it-works.md` to describe the editor, its grammar, and the instant resume.
   - Extend README.md's "Control the loops" row: where the `--reason` text names the surfaces that show it, also say that the TUI's Ctrl+F takes a duration and reason.

**Files touched.** `src/ui/tui/tui-input.ts`, `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`, `test/tui-operator-keys.test.ts`, `test/tui-input.test.ts` (where `parseDeferInput`'s tests live), `test/tui-frame.test.ts`, `docs/how-it-works.md`, `README.md`.

**Acceptance criteria.**
- Unit tests for `parsePauseInput` cover these inputs:
  - `""` → standing pause with no reason;
  - `"2h"` → `forMs` 7200000 with no reason;
  - `"2h deploy freeze"` → duration and reason;
  - `"deploy freeze"` → reason only;
  - `"91d"` → the cap error.
- In `test/tui-operator-keys.test.ts`, the existing test "Ctrl+F toggles the fleet pause marker through pauseFleet/resumeFleet and flashes the shared wording" is updated: Ctrl+F then Enter on an empty line pauses (`isFleetPaused` true), and a second Ctrl+F resumes immediately.
- A new test covers `Ctrl+F`, typing `1h maintenance`, then Enter. After it, `standingFleetPause(repo)` (`src/fleet/fleet-state.ts`) carries an `until` about one hour ahead and the reason `maintenance`, and the frame shows the reason in the fleet alert.
- A new test shows that Esc in the editor leaves the fleet unpaused and restores a director draft typed before Ctrl+F.
- A new test shows that a `91d` entry flashes the cap error and keeps the editor open.
- The test "Ctrl+F is inert while the budget editor or the role-prompt editor holds the prompt line" still passes. Ctrl+B and Ctrl+L in pause-edit mode flash the "finish or cancel the pause first" message.
- `test/tui-frame.test.ts` asserts the pause-edit `hintLine` keys and the `pause` prompt prefix.
- `npm run test` passes.

### Edit or clear a loop's notebook from the dashboard's loop drawer, matching `tumwater role <id> --notes-file` / `--clear-notes` (planned 2026-10-12 by plan; sibling of the landed CLI notebook write (`cmdRole`'s `--clear-notes`/`--notes-file` branch in `src/cli/cli-query-commands.ts` over `saveRoleNote` in `src/agent/role-notes-write.ts`) and the landed read-only drawer notebook (`drawerRoleSection`/`loadDrawerRole` in `src/ui/gui/gui-client-drawer.ts` over `GET /api/role`). The TUI Ctrl+N pane stays read-only and is a separate, later sibling) — done 2026-10-12

**Goal.** The loop drawer shows a loop's notebook, but correcting a stale or wrong note means switching to the CLI. Add **Edit** and **Clear** controls to the drawer's Notebook section. Both write through the same `saveRoleNote` the CLI, MCP, and pi surfaces use, so the 4 KB cap and its wording cannot drift.

**Approach.**
1. Server: add `handleRoleNotes` in `src/gui/gui-endpoint-commands.ts` for `POST /api/role-notes`, with body `{"role": "<id>", "text": "<note>"}`. `"text": ""` clears the notebook.
   - Open with `readRoleBody(req, res, '{"role": "feature", "text": "…"}', root)`, and update `readRoleBody`'s doc comment, which counts its call sites ("Exactly five call sites"), to name six.
   - Reject `role === DIRECTOR_ROLE` (from `src/roles/roles.ts`) with 400 `"the director has no notebook"`, the CLI's wording.
   - Reject a non-string `text` with 400 before anything is written. Do not pass it on to `saveRoleNote`'s throw.
   - Call `saveRoleNote(roleNotesPath(root, role), text)` inside try/catch. A thrown validation error (over 4 KB) answers 400 with `{ error: errorMessage(err) }`. Success answers 200 `{ ok: true, message }`, where `message` is `saveRoleNote`'s return ("notebook cleared" / "notebook saved (N bytes)").
   - Register `"POST /api/role-notes": (req, res) => handleRoleNotes(req, res, root)` in `src/gui/gui-server.ts`'s route table, next to `/api/reset-counters`.
2. Client drawer (`src/ui/gui/gui-client-drawer.ts`): add `noteEditing = null; // { role, text }` with `startNoteEdit(role, text)` and `stopNoteEdit()`, mirroring `entryEditing`/`startEntryEdit`/`stopEntryEdit`. Add a clear confirm that mirrors `confirmEntryCancel`/`armEntryCancel`/`entryCancelArmed`/`disarmEntryCancel`: the first click arms it for 5 s and the second click posts.
   - In `drawerRoleSection`, while `noteEditing` is set for the open role, render the Notebook section as `<textarea id='noteedittext' rows='12'>` holding the captured text (not the live payload, so a poll refetch does not wipe the draft and the panel string stays stable for `paintPanel`), plus Save (`data-act='note-save'`) and Discard (`data-act='note-discard'`) buttons.
   - Otherwise, the `sec-head` gains an "Edit" button (`data-act='note-edit'`, `data-arg=role`). When a note exists it also gains "Clear" (`data-act='note-clear'`), which reads "Click again to clear" while armed.
   - Closing the drawer clears `noteEditing` and the clear confirm.
   - Hide both buttons for the director: its drawer has no notebook to write, so check the role against `"director"`.
3. Client actions (`runAct` in `src/ui/gui/gui-client-boot.ts`), next to the `entry-edit*` branches:
   - `note-edit` calls `startNoteEdit(arg, current note or "")`.
   - `note-discard` calls `stopNoteEdit()` and repaints.
   - `note-save` posts `{ role, text: textarea.value }` to `/api/role-notes` through `postAction`. On success it stops editing, refetches with `loadDrawerRole(role)`, and flashes the server's `message`.
   - `note-clear` arms on the first click. On the second it posts `{ role, text: "" }`, then refetches and flashes the same way.
   - Saving an empty textarea is allowed: it is the same write as Clear, as with `role_notes`' `""`.
4. Docs: in README.md's "Check state" row, extend the `tumwater role <id>` sentence to say the dashboard's loop drawer edits or clears the notebook the same way. `src/cli/help.ts` lists no dashboard routes, so it needs no change.

**Files touched.** `src/gui/gui-endpoint-commands.ts`, `src/gui/gui-server.ts`, `src/ui/gui/gui-client-drawer.ts`, `src/ui/gui/gui-client-boot.ts`, README.md, and tests in `test/gui-endpoints.test.ts`, `test/gui-client-drawer.test.ts`, and `test/gui-client-boot.test.ts`.

**Acceptance criteria.**
- `test/gui-endpoints.test.ts` covers `POST /api/role-notes`:
  - `{role:"feature", text:"x\ny"}` returns 200 and writes `roleNotesPath(root,"feature")` byte-for-byte.
  - `text:""` empties the notebook.
  - An unknown role gets 400 with the shared `rejectBadRole` wording.
  - `role:"director"` gets 400 and writes nothing.
  - A non-string `text` gets 400 and leaves the note unchanged.
  - Text over `ROLE_NOTES_MAX_BYTES` gets 400 naming the byte count and leaves the note unchanged.
- `test/gui-client-drawer.test.ts` covers the panel:
  - With a note, the `drawerrole` panel shows Edit and Clear buttons. With no note, it shows Edit only.
  - While editing, it shows a `noteedittext` textarea holding the captured text, and a payload change does not alter the painted panel.
- `test/gui-client-boot.test.ts` covers the actions:
  - `note-save` posts `["/api/role-notes", { role, text }]`.
  - `note-clear` posts nothing on the first click and `{ role, text: "" }` on the second.
  - `note-discard` posts nothing.
- `npm run test` passes.

### Clear or replace a loop's notebook from the CLI: `tumwater role <id> --clear-notes` and `tumwater role <id> --notes-file <path>` (planned 2026-10-12 by plan; sibling of the landed read-only notebook views — `tumwater role <id>` (`rolePayload` in `src/roles/role-view.ts`), the dashboard loop drawer, and the TUI's Ctrl+N notebook pane; independent of the TUI backlog title-edit plan above; done 2026-10-12 by feature)

**Goal.** A role's notebook (`.tumwater/state/notes/<role>.md`, `roleNotesPath` in `src/paths.ts`)
rides into every fresh tick (`src/tick/tick-prompt.ts`), yet only the model can change it, through
the `role_notes` tool. When a note goes stale or wrong (it names a moved file, or says a ruled-out
path is the way), the operator can read it in three places but can fix it in none, short of
editing a file under `.tumwater/`. Give the operator the same write the model has: clear the note,
or replace it from a file. Dashboard and TUI writes are separate later siblings, not this plan.

**Approach.**
- `src/cli/cli-query-commands.ts` `cmdRole`: accept two new flags, defined beside `FILE_SPEC` as
  `CLEAR_NOTES_SPEC = { names: ["--clear-notes"] }` and
  `NOTES_FILE_SPEC = { names: ["--notes-file"], value: true, valueName: "<path>" }`, and add both
  to `cmdRole`'s `rejectUnknownArgs("role", …)` list.
  - When either is present: `fail` if both are given (`give --clear-notes or --notes-file, not
    both`), and if `--json` is also given (`--json does not apply to a notebook write`). After
    the id checks `cmdRole` already does, `fail` when the id is `DIRECTOR_ROLE` (`the director
    has no notebook`). Reject an unknown id with the same `unknownRoleMessage(id,
    knownRoleIds(cfg))` throw `rolePayload` uses. Read `cfg` with `loadConfigSafe(root)`,
    falling back to `defaultConfig()` as `rolePayload` does.
  - `--clear-notes` writes `""`. `--notes-file <path>` reads the text through
    `readPromptFileArg` (`src/cli/cli-command-args.ts`: `-` reads stdin, and a missing or empty
    file fails with its existing wording; clearing is `--clear-notes`'s job). Both write
    through `saveRoleNote(roleNotesPath(root, id), text)` (`src/agent/role-notes-write.ts`), so
    the 4 KB cap and the atomic write are the model's own. Catch its throw and `fail` with the
    message. On success print `<id>: <saveRoleNote's message>`, e.g. `feature: notebook cleared`
    or `feature: notebook saved (123 bytes)`. Send no wake and log no event: the note is read
    at the next tick start either way.
  - Without either flag, `cmdRole` behaves exactly as now.
- `peelRolePositional` (same file) currently skips only `--role`'s value when it looks for the
  positional id, so `tumwater role --notes-file n.md feature` would take `n.md` as the id.
  Generalize it to skip the value token after any of `--role` and `--notes-file`, and update its
  doc comment.
- A tick that is running when the operator writes can still replace the note through its own
  `role_notes` call: the latest write wins. Say this in the help text and in the docs paragraph.
  Do not add locking.
- `src/cli/help.ts`: add `tumwater role <id> --clear-notes` and `tumwater role <id> --notes-file
  <path>` entries under `tumwater role <id> [--json]`.
- `README.md` "Check state" row: after the `tumwater role <id>` description, add one clause:
  `--clear-notes` clears that loop's notebook and `--notes-file <path>` (`-` for stdin) replaces
  it (4 KB cap).
- `docs/how-it-works.md`: in the notebook paragraph (the one that starts "Each role also has a
  notebook"), add one sentence saying the operator can clear or replace a note with those two
  flags, and that a tick running at that moment may still overwrite it.

**Files touched.** `src/cli/cli-query-commands.ts`, `src/cli/help.ts`, `README.md`,
`docs/how-it-works.md`, `test/cli-operators.test.ts`. No change to `src/agent/role-notes-write.ts`,
which already exports `saveRoleNote`.

**Acceptance criteria.**
- In `test/cli-operators.test.ts`, a new test (next to "role prints one loop's standing
  prompt…") covers each of the following:
  - `role feature --notes-file <tmp file "use fleet.ts">` exits 0 and prints `feature: notebook
    saved`. `roleNotesPath(repo, "feature")` then holds the file's text, and `role feature`
    shows it.
  - `role --notes-file <file> feature` (flag before id) writes the same note, so the
    positional peel skips the flag's value.
  - `role feature --clear-notes` exits 0 and prints `feature: notebook cleared`. The file is
    then empty, and `role feature --json` reports `note: null`, per `rolePayload`'s
    empty-means-none rule.
  - A file over 4096 bytes exits 1 with `shorten it to at most 4096 bytes` on stderr, and
    the old note is left unchanged.
  - Each of these exits 1 with its message: `--clear-notes --notes-file x` together,
    `--clear-notes --json` together, `role director --clear-notes`, and `role bogus
    --clear-notes` (which gets the `unknown role: bogus` wording).
- The existing `role` tests ("role prints one loop's standing prompt…" and "role validates its
  arguments like every other command") pass unchanged.
- `tumwater help role` lists both new forms.
- `npm run test` passes.

### Edit a planned feature's or open bug's title from the TUI backlog pane, matching `tumwater plan|bug --edit <n>` and the dashboard drawer's Edit (planned 2026-10-12 by plan; sibling of the landed TUI backlog Ctrl+X cancel and Ctrl+A answer; independent of the dashboard multiline-answer plan above; done 2026-10-12 by feature)

**Goal.** The TUI backlog pane can cancel a selected plan or bug (Ctrl+X twice) and answer a selected question (Ctrl+A), but it cannot edit an entry. The CLI (`plan|bug --edit <n>`) and the dashboard drawer (`POST /api/backlog-edit` → `tryEditEntry`) both can. Add Ctrl+E (mnemonic **E**dit) on a selected plan or bug. It opens a prompt-line editor pre-filled with the entry's title. Enter saves the new title through the same non-exiting `tryEditEntry` core the dashboard uses, keeping the entry's body line for line and its `(planned …)`/`(reported …)` stamp. The prompt line is single-line, so this edits the title only. Body editing stays with the dashboard drawer and the CLI `--file` forms.

**Approach.**
1. `src/ui/tui/tui-keys.ts`, `createTuiKeys`. Mirror the Ctrl+A answer editor (`answerFor`, `answerSavedInput`/`answerSavedCursor`, `exitAnswerMode`):
   - Add the state `let entryEditFor: { kind: "plan" | "bug"; position: number; title: string } | null = null`, plus `entryEditSavedInput`/`entryEditSavedCursor`. Add an `exitEntryEdit()` modeled on `exitAnswerMode`. Expose `entryEditFor` in the snapshot object next to `answerFor`, and add it to the snapshot type with a doc comment like `answerFor`'s.
   - Add a new branch placed **before** the general Ctrl+E (report-window) branch. Its guard: `key.ctrl && key.name === "e"`, no other editor open, `view === roleIds.length + 1 && selectedEntry !== null`.
     - Resolve the entry with `flat()` and clamp `sel` as the Ctrl+X branch does.
     - A question flashes `only a plan or open bug can be edited here`.
     - For a plan or bug, compute `kind`/`position` exactly as the Ctrl+X branch does. Settle prompt recall the way Ctrl+A does, then set `entryEditFor = { kind, position, title: picked.title }`. Pre-fill `input = stripEntryStamp(picked.title)` (import from `../../backlog/backlog-structure.js`) with the cursor at the end. Flash `editing <kind> #<n> — Enter to save, Esc to cancel`.
     - An emptied list does nothing.
     - Ctrl+E on the backlog pane with no selection keeps falling through to the report-window branch, unchanged.
   - Every `!answerFor` guard, and every `answerFor` arm of the "finish or cancel … first" flash chains (the Ctrl+B branch and its siblings), gains the matching `entryEditFor` term. The edit flash reads `finish or cancel the entry edit first (Esc cancels)`. Use grep to confirm that each site carrying `answerFor` also carries `entryEditFor`.
   - Wherever `exitAnswerMode()` runs on Ctrl+T, `exitEntryEdit()` runs too. Add an Esc branch beside the `answerFor` one: `exitEntryEdit()` and flash `edit cancelled`.
   - Add an Enter arm beside the `answerFor` one:
     - A whitespace-only line flashes `an entry needs a title` and stays in the editor.
     - Otherwise, re-read `flat()` and take the entry at the target's flat index. Plans come first, so the index is `position - 1` for a plan and `plans + position - 1` for a bug. If that entry is missing or its title differs from `target.title`, treat it as moved without writing.
     - If it matches, call `tryEditEntry(root, kind, position, target.title, input, entry.body)`. Re-reading the body at Enter keeps a concurrent body edit from being clobbered by a stale copy.
     - On `edited`: exit the editor, keep `selectedEntry` (same position), and flash `edited <kind> #<n>: <outcome.title>`.
     - On `gone`/`moved`: exit the editor, set `selectedEntry = null` and `entryScroll = 0`, and flash `that <kind> was already removed or moved — nothing edited`.
     - A throw goes through `flashError` and stays in the editor.
2. `src/ui/tui/tui-frame.ts`:
   - Add an **optional** `entryEditFor?: { kind: "plan" | "bug"; position: number; title: string } | null` to the mode parameter of `hintLine` and `promptPrefix`. Optional so the existing test call sites in `test/tui-frame.test.ts` compile unchanged.
   - `hintLine`: when it is set, show `[["Enter", "save title"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]`. Add `entryEditFor` to the `!mode.answerFor` condition that gates the trailing hints.
   - Backlog view keys: insert `["Ctrl+E", "edit entry"]` after `["Ctrl+X", "cancel entry"]`.
   - `promptPrefix`: when it is set, return the prefix `edit <kind> #<n>` in the `brand` tone.
3. `src/ui/tui/tui.tsx`: pass `entryEditFor: s.entryEditFor` in the `mode` object built for `hintLine`/`promptPrefix`.
4. Docs: in the README.md "Steer the project" row, extend "and the TUI's backlog pane does too, with Ctrl+X pressed twice on the selected entry" with "and edits the selected entry's title with Ctrl+E". (docs/how-it-works.md does not list the backlog pane's keys today, so it needs no change.)

**Files touched.** `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`, README.md, `test/tui-keys.test.ts`, `test/tui-frame.test.ts`.

**Acceptance criteria.**
- `test/tui-keys.test.ts`, modeled on `the backlog pane answers the selected open question through tryAnswerQuestion` and the `backlog Ctrl+X …` tests, against a temp repo whose PLANS.md/BUGS.md carry stamped entries with multi-line bodies:
  - Ctrl+E on a selected bug pre-fills the stamp-stripped title. Retyping it and pressing Enter rewrites the heading with the new title, the original stamp, and a byte-identical body. The flash names `edited bug #<n>`.
  - Ctrl+E on a selected question flashes `only a plan or open bug can be edited here` and writes nothing.
  - Esc restores the prior prompt draft and leaves the file byte-identical.
  - A blank title on Enter flashes `an entry needs a title` and keeps the editor open.
  - If the entry is rewritten on disk between Ctrl+E and Enter, nothing is edited and the moved notice flashes.
  - While the edit is open, Ctrl+B flashes `finish or cancel the entry edit first (Esc cancels)`.
  - Ctrl+E on the backlog pane with no selection still advances the report window (existing behavior).
- `test/tui-frame.test.ts`: `hintLine` with `entryEditFor` set shows `save title`. The backlog view's hint lists `Ctrl+E edit entry`. `promptPrefix` shows `edit plan #2`.
- `npm run test` passes.

### The dashboard's question drawer records a multiline answer with its lines kept, matching `tumwater questions answer <n> --file` (planned 2026-10-12 by plan; sibling of the landed `questions answer --file` (`answerQuestionFromText` in `src/cli/question-commands.ts`); independent of the TUI-answer and `prompt --edit --file` plans) (done 2026-10-12)

**Goal.** The question drawer already gives the operator a multi-line `<textarea id='answertext'>` (`src/ui/gui/gui-client-drawer.ts`). But `handleQuestionAnswer` (`src/gui/gui-endpoint-commands.ts`) calls `tryAnswerQuestion(root, position, decision, title)` without `keepLines`, so `collapseWhitespace` folds a typed list or paragraph break into one line. The CLI's `--file` form now keeps lines behind `bodyStructureProblem`. The dashboard should record what the operator typed the same way.

**Approach.**
1. `src/gui/gui-endpoint-commands.ts`, `handleQuestionAnswer`. After the existing blank-decision check:
   - Normalize with `normalizeEntryBody(decision)`. It is already imported there.
   - Run `bodyStructureProblem` on the normalized text. A non-null problem answers `400 { error: problem }` and writes nothing. That is the same shape `handleBacklogEdit` uses.
   - Then call `tryAnswerQuestion(root, position, body, title, true)`.
   - Update the doc comment: the decision keeps its lines (the `--file` form's rule), and a `## `/`### ` heading line or an unclosed fence in the decision answers 400.
   - The response's `decision` stays `outcome.decision` (what landed).
2. `src/ui/gui/gui-client-boot.ts`, the `answer-record` branch: no change. It already sends `area.value.trim()`, which keeps inner newlines. Confirm the flash text doesn't echo the decision. It doesn't: it echoes only the title.
3. README.md, "Answer open questions" row: change "the dashboard's question drawer records an answer the same way" to say the drawer records it with its lines kept, as `--file` does.
4. `answerQuestionLocked` and `tryAnswerQuestion` need no change. The CLI positional form keeps folding.

**Files touched.** `src/gui/gui-endpoint-commands.ts`, `test/gui-endpoints.test.ts`, README.md.

**Acceptance criteria.**
- In `test/gui-endpoints.test.ts`, the test "handleQuestionAnswer answers, goes gone on stale input, and guards bad bodies and fences" changes as follows:
  - Its first answer, `"use\nink"`, now lands with its lines kept. The response `decision` is `"use\nink"`. QUESTIONS.md holds the `**Answered <date> by operator:**` stamp followed by `use\nink` on their own lines, in the layout `answerQuestionFromText` produces. Copy the expected shape from the test "questions answer --file keeps the decision's lines, in either flag position" in `test/cli-questions-strictness.test.ts`.
  - New cases each answer 400 and leave the file byte-identical:
    - a decision containing a line `## Phantom`;
    - a decision containing an unclosed ```` ``` ```` fence.
    - The 400 error text comes from `bodyStructureProblem`.
  - A decision with `\r\n` line endings lands with `\n` only.
  - The existing stale, out-of-range, blank, non-integer, missing-title, and 409-fence assertions still pass unchanged.
- The CLI positional `tumwater questions answer <n> "a\nb"` still folds to `a b`. Its existing test "a multi-line decision folds to one line, so no line of it can start a new section" in `test/question-commands.test.ts` passes untouched.
- `npm run test` passes.

### `tumwater prompt --edit <n> --file <path>`: rewrite a queued prompt from a file (planned 2026-10-12 by plan; sibling of the landed `tumwater prompt --file` (`readPromptFileArg` in `src/cli/cli-command-args.ts`) and the landed `tumwater plan|bug --edit <n> --file`. Independent of the waiting "Answer an open question from the TUI backlog pane" and "`tumwater questions answer <n> --file <path>`" plans: it touches only `parsePromptArgs`, `src/cli/help.ts`'s prompt stanza, README.md's Steer row, and prompt tests — no `src/ui`, `src/gui`, `src/backlog`, or question file; done 2026-10-12 by feature)

**Goal.** `tumwater prompt --file <path>` queues a multi-line prompt read from a file (or stdin with `-`), but `prompt --edit <n>` only takes typed positional text, which the shell flattens and which is awkward for a long, structured request. `parsePromptArgs` refuses the pair outright (`refuseQueueOnlyFlag("--file", …)` fires for `--edit`; test "parsePromptArgs --edit refuses --file: the replacement text is typed, never read"). The edit storage already keeps lines: `editPromptAtFile` in `src/inbox/inbox-edit.ts` only trims the text, then length-checks and writes it. So the gap is in the parser alone. Add `--file <path>` to the `--edit` form so the operator can revise a queued prompt from a file. The prompt keeps its position, enqueue stamp, and pending `--at` deferral, as the typed edit does today.

**Approach.**
1. `src/cli/cli-command-args.ts`, `parsePromptArgs`:
   - Narrow the `--file` refusal to `--list`/`--cancel`. Do it the same way `--attach` is exempted: `refuseQueueOnlyFlag("--file", fileFlag >= 0 && editFlag < 0)`. Update the comment above `refuseQueueOnlyFlag`, which says an edit's replacement text "is typed, never read from a file", so it says `--edit` accepts `--file` as its replacement text.
   - In the `editFlag >= 0` branch, when `fileFlag >= 0`:
     - Claim the `--file` pair the way `roleClaim`/`attachClaims` are claimed, both in the before-position loop and when collecting text tokens.
     - Refuse any leftover text token with `fail("unexpected argument <json> — with --file the replacement text comes from the file")`, matching `failStrayArg`'s wording. Reuse `failStrayArg(args, "with --file the replacement text comes from the file", editFlag, editFlag + 1, fileFlag, fileFlag + 1, ...roleClaim, ...attachClaims)` if its contract fits. Check its signature first.
     - Read the text with `readPromptFileArg(promptFileValue(args[fileFlag + 1]))`. That covers a missing value (`--file needs a path`), an unreadable file, an empty file, and memoized stdin `-`.
     - Return `{ mode: "edit", role, position: n, text, attachPaths }` with that text untouched. `editPromptAtFile` trims it.
   - Without `--file`, the branch is unchanged. `PromptArgs` needs no new field.
2. `src/inbox/prompt-commands.ts`: no change expected. `cmdPrompt`'s edit branch passes `parsed.text` through. Confirm the edit confirmation line still prints. It echoes the text, so check how `sayPromptOutcome`/`sayListedOutcome` render a multi-line text. If they print it whole, leave it. If they truncate to the first line, leave that too. Don't add new rendering.
3. `src/cli/help.ts`: in the prompt stanza, add `tumwater prompt --edit <n> --file <path> [--attach <path>]` after the existing `--edit` entry. It replaces the Nth queued prompt's text with the file's contents (`"-"` reads stdin), kept line for line. Position, age, and `--at` deferral are kept, and `--role <id>` disambiguates like `--edit`. `FREEFORM_VALUED_FLAGS.prompt` already lists `--file` and `--edit`, so it needs no change.
4. README.md, Usage table's "Steer the project" row: extend the `tumwater prompt --edit <n> "new text" [--attach <path>]` clause with "or `--edit <n> --file <path>` to take the replacement from a file". Don't edit the prompt markers.

**Files touched.** `src/cli/cli-command-args.ts`, `src/cli/help.ts`, README.md, `test/cli-command-args.test.ts`, `test/prompt-commands.test.ts`.

**Acceptance criteria.**
- `test/cli-command-args.test.ts`:
  - Replace the test "parsePromptArgs --edit refuses --file: the replacement text is typed, never read". The new test writes a temp file holding `line one\n\nline two\n`. `parsePromptArgs(["--edit", "2", "--file", f])` then deep-equals `{mode: "edit", role: null, position: 2, text: "line one\n\nline two\n", attachPaths: []}`. With `--role bugfix` before or after the pair, the result has `role: "bugfix"`. With `--attach a.png`, `attachPaths` is `["a.png"]`.
  - These calls fail:
    - `["--edit", "2", "--file", f, "extra"]` and `["--edit", "2", "extra", "--file", f]` each fail naming `"extra"`;
    - `["--edit", "2", "--file"]` fails with `--file needs a path`;
    - an empty file fails with `is empty`;
    - `["--list", "--file", f]` and `["--cancel", "1", "--file", f]` still fail with `--file only queues a prompt`;
    - `["--edit", "1", "--file", f, "--at", "5m"]` still fails with `--at only queues a prompt`.
- `test/prompt-commands.test.ts` adds a test modeled on "prompt --edit --role rewrites the entry in place and keeps its list position and stamp". It queues two bugfix prompts, then runs `cmdPrompt(root, ["--role", "bugfix", "--edit", "1", "--file", f])` with `f` holding `first\n\nsecond paragraph\n`. The first queue file still exists, and its content (marker stripped) is `first\n\nsecond paragraph`, with the inner blank line kept. `--list` still shows it at position 1 and the other prompt at position 2. Exactly one `prompt_edited` event is logged. A missing file path exits non-zero, and the queue files are byte-identical to before.
- The help test that matches the prompt `--edit` stanza (find it with grep for `prompt --edit` under `test/`) also matches `tumwater prompt --edit <n> --file <path>`. If no such test exists, add an assertion to the help-stanza test file that covers `tumwater help prompt`.
- `npm run test` passes.


### Answer an open question from the TUI backlog pane, matching `tumwater questions answer <n>` and the dashboard's answer form (planned 2026-10-12 by plan; sibling of the landed CLI `tumwater questions answer` (`answerQuestion` in `src/cli/question-commands.ts`) and the landed dashboard answer form (`POST /api/question-answer`, `handleQuestionAnswer` in `src/gui/gui-endpoint-commands.ts`). Independent of the waiting "Edit a planned feature or open bug from the dashboard's entry drawer" plan: it touches neither `backlog-write.ts` nor the GUI) (done 2026-10-12 by feature)

**Goal.** The TUI's project-status (backlog) pane already lets the operator browse open questions in full (Up/Down set `selectedEntry`), but the TUI can't record an answer. The brief says the TUI "gives user a main prompt", and an open question is the one thing loops wait on a human for. With a question selected, **Ctrl+A** (mnemonic: **A**nswer) opens an answer editor on the prompt line. **Enter** records the decision through the same non-exiting core the dashboard uses. **Esc** cancels and restores the draft.

**Approach.**
1. `src/ui/tui/tui-keys.ts`, `createTuiKeys`: add a new prompt-line editor beside the budget, role-prompt, search, defer, and Queued-edit editors, modeled on the Queued pane's in-place editor (`queuedEditFor` / `queuedSavedInput` / `queuedSavedCursor` / `exitQueuedEdit`):
   - state `let answerFor: { position: number; title: string } | null = null` with its own saved pair `answerSavedInput` / `answerSavedCursor`, and `exitAnswerMode()` that restores the pair and calls `resetPromptRecall` (mirror `exitQueuedEdit` exactly).
   - a new branch for `key.ctrl && key.name === "a"` placed after the transcript-view `p/a/w/r` branch (that branch is guarded to `view >= 1 && view <= roleIds.length`, so it never sees the backlog view `roleIds.length + 1`). Guard it with `view === roleIds.length + 1 && selectedEntry !== null` and none of `budgetMode`, `rolePromptFor`, `searchMode`, `deferMode`, `queuedEditFor`, or `answerFor` set. Resolve the selection the way the PgUp/PgDn entry branch does: `const entries = flat(); const sel = Math.min(selectedEntry, entries.length - 1)`. If `entries[sel].label !== "question"`, flash `only an open question can be answered here` and leave the line untouched. Otherwise `position = sel - entries.filter((e) => e.label !== "question").length + 1`. That's the 1-based index among the open questions, because `labeledBacklogEntries` (tui-backlog.ts) lists plans, then bugs, then questions. Save the draft with `settlePromptRecall` exactly as the queued editor does, blank the line, set `answerFor = { position, title: entries[sel].title }`, and flash `answering question #<position> — Enter to record, Esc to cancel`.
   - Esc: a branch `key.name === "escape" && answerFor` beside the queued one calls `exitAnswerMode()` and flashes `answer cancelled`.
   - Enter: an `else if (answerFor)` arm in the `key.name === "return"` branch, beside the `queuedEditFor` arm. A whitespace-only line flashes `questions answer needs a decision` and stays in the editor. Otherwise call `tryAnswerQuestion(root, answerFor.position, input, answerFor.title)` (import it and `UNCLOSED_FENCE_MESSAGE` from `../../cli/question-commands.js`; tui-keys.ts already imports `durationLabel` from `src/cli`). Map the outcome:
     - `answered`: `exitAnswerMode()`, `selectedEntry = null` (the answered entry left the list; return to list mode), flash `answered question #<n>: <title>`.
     - `missing` / `moved`: `exitAnswerMode()`, `selectedEntry = null`, flash `that question was already answered or moved — nothing recorded`.
     - `fenced`: flash `UNCLOSED_FENCE_MESSAGE` and stay in the editor.
     - a throw: `flashError(err)` and stay in the editor, so the text survives for a retry. That's the queued editor's contract.
   - Ctrl+T: call `exitAnswerMode()` beside the existing `exitQueuedEdit()` call.
   - Every existing guard that lists `queuedEditFor` also gets `answerFor`, so every prompt-line editor stays mutually exclusive. Find them with `grep -n queuedEditFor src/ui/tui/tui-keys.ts`; that includes the Ctrl+B and Ctrl+L refusal branches, whose "finish or cancel the … first (Esc cancels)" wording gains an answer arm (`finish or cancel the answer first (Esc cancels)`). Up/Down and PgUp/PgDn on the backlog view are also inert while `answerFor` is set, so the selection cannot move under an open editor: add `!answerFor` to those two branches' guards.
   - Expose `answerFor` on the `TuiKeys` state interface (doc comment beside `queuedEditFor`) and in the returned `state()` object.
2. `src/ui/tui/tui-frame.ts`: widen the `mode` parameter of `hintLine` and `promptPrefix` with `answerFor: { position: number; title: string } | null`. With `answerFor` set, `hintLine` shows `[["Enter", "record answer"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]`, and `promptPrefix` returns `[{ text: \`answer #${position}\`, tone: "brand" }, { text: " › " }]`. The trailing Ctrl+L defer hint is suppressed like the other editors. The backlog-view hint gains `["Ctrl+A", "answer question"]` after `["↑↓", "open entries"]`.
3. `src/ui/tui/tui.tsx`: pass `answerFor: s.answerFor` in the `mode` object built for the frame.
4. README.md: the "Answer open questions" row of the Usage table gains a mention that the TUI's backlog pane answers the selected question with Ctrl+A. Keep the sentence short.

**Files touched.** `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`, `README.md`, `test/tui-keys.test.ts`, `test/tui-frame.test.ts`. No change to `src/cli/question-commands.ts`: `tryAnswerQuestion` already takes `expectedTitle` and holds the primary-worktree lock.

**Acceptance criteria.**
- In `test/tui-keys.test.ts`, using the file's `makeRoot`/`makeKeys` helpers and a temp root whose QUESTIONS.md has two open questions and PLANS.md has one planned entry: Ctrl+T to the backlog view, Down until the second question is selected, Ctrl+A. Then `state().answerFor` deep-equals `{ position: 2, title: <second title> }` and the prompt line is blank. Type a decision and press Enter: the file's `## Answered` gains that block and an `**Answered <today> by operator:** <decision>` line, the first question stays open, `answerFor` is null, `selectedEntry` is null, the flash matches `/answered question #2/`, and the draft typed before Ctrl+A is restored.
- Ctrl+A with a plan selected flashes `only an open question can be answered here`, leaves `answerFor` null, and keeps the line unchanged. Ctrl+A in list mode (`selectedEntry` null) does not open the editor.
- Esc in the editor restores the saved draft and writes nothing (QUESTIONS.md byte-identical). A whitespace-only Enter flashes and keeps `answerFor` set.
- Edit QUESTIONS.md so a different question sits at the saved position, after Ctrl+A and before Enter. Enter then writes nothing (QUESTIONS.md is byte-identical to the edited content), flashes the `already answered or moved` notice, and leaves the editor.
- While `answerFor` is set, Ctrl+B, Ctrl+L, and Up/Down leave `answerFor`, the budget/defer modes, and `selectedEntry` unchanged. Ctrl+T clears `answerFor` and restores the draft.
- `test/tui-frame.test.ts`: `hintLine` with `answerFor` set names `record answer` and omits the defer hint. `promptPrefix` renders `answer #2 › `. The backlog-view hint names `Ctrl+A`. Existing `hintLine`/`promptPrefix` callers in tests compile with the widened mode type (pass `answerFor: null`).
- `npm run test` passes.

### `tumwater questions answer <n> --file <path>`: record a multiline decision with its lines kept (planned 2026-10-12 by plan; sibling of the landed `tumwater plan|bug --file` (`splitEntryFile`, `normalizeEntryBody`, `bodyStructureProblem` in `src/backlog/backlog-write.ts`) and the landed `plan|bug --edit <n> --file`. Independent of the waiting "Answer an open question from the TUI backlog pane" plan: that one only calls `tryAnswerQuestion` with its existing four arguments from `src/ui/tui/tui-keys.ts`, and this plan keeps that signature working (it adds an optional trailing parameter). No `src/ui` or `src/gui` file is touched); done 2026-10-12 by feature

**Goal.** Loops post questions that often need a structured answer: a list of options kept, a short rationale, a code snippet. Today `tumwater questions answer <n> "<decision>"` folds the decision to one line (`collapseWhitespace` in `answerQuestionLocked`, `src/cli/question-commands.ts`), so a bullet list arrives as one run-on sentence. `plan` and `bug` already take `--file <path>` (`-` for stdin) with lines kept. Give `questions answer` the same form, with the same structural guard that keeps a stray `## ` line from adding a phantom section to QUESTIONS.md.

**Approach.**
1. `src/cli/question-commands.ts`:
   - Add an optional trailing parameter `keepLines = false` to `tryAnswerQuestion(root, n, rawDecision, expectedTitle?, keepLines?)` and thread it to `answerQuestionLocked`. When it is true, `decision = normalizeEntryBody(rawDecision)` (import from `../backlog/backlog-write.js`) instead of `collapseWhitespace(rawDecision)`. Existing callers (`answerQuestion`, `handleQuestionAnswer` in `src/gui/gui-endpoint-commands.ts`) pass nothing, so their behavior does not change.
   - The answer paragraph: when `decision` has no `\n`, keep today's single line `**Answered <date> by operator:** <decision>`, so a one-line file answer matches the positional form byte for byte. When it holds several lines, write `**Answered <date> by operator:**`, a blank line, then the decision's lines verbatim. Build it as an array spliced into `answerLines` in place of the single stamped string. Both the no-`## Answered` branch and the insert branch already consume `answerLines`.
   - Add an exported `answerQuestionFromText(root, n, text): { title; decision }`, the CLI entry for the file form. It computes `const body = normalizeEntryBody(text)`, then `fail('questions answer needs a decision: the file is blank')` when `body === ""`, and `fail(\`questions answer --file: ${problem}\`)` when `bodyStructureProblem(body)` returns a problem (also imported from backlog-write). Then it calls `tryAnswerQuestion(root, n, body, undefined, true)` and maps refusals exactly as `answerQuestion` does. Factor that mapping into a small private helper both callers share rather than copying the three `fail` lines.
   - Update `answerQuestionLocked`'s doc comment: the fold applies to the positional form, and the `--file` form keeps lines behind `bodyStructureProblem`, the same guard `plan --file` uses.
2. `src/cli/cli-query-commands.ts`, `cmdQuestions`: in the hand-rolled arg scan, recognize `--file` at any position, consuming the next token through `promptFileValue` (import from `./cli-command-args.js`). Refuse a repeat with `rejectRepeatFlag(..., "--file")`. This is safe past the number positional too: every `--`-prefixed token other than `--json` is refused there today, so no accepted invocation changes meaning. Pass `[JSON_FLAG, FILE_SPEC]` to `rejectEqualsForm`, where `FILE_SPEC = { names: ["--file"], value: true, valueName: "<path>" }` is a local const, and add `--file` to the unknown-argument message's flag list. With `--file` set:
   - `words` after the number must be empty. Otherwise `fail(\`unexpected argument ${JSON.stringify(words[2])} — with --file the decision comes from the file\`)`, the wording `fileAndAnnounce` uses.
   - The `answer` subcommand and number checks stay as they are.
   - Read the text with `readPromptFileArg(file)` (it handles `-` and refuses an empty file), then call `answerQuestionFromText` and `sayAnswered(n, title, jsonFlag, decision)`. The `--json` payload's `decision` then carries the kept lines.
   - `--file` with no `answer` subcommand (`questions --file x`) fails through the existing unknown-subcommand / list path. Specifically, when `words` is empty and `--file` was given, fail with `--file only applies to questions answer <n>`.
3. `src/cli/help.ts`: add a usage line `tumwater questions answer [--json] <n> --file <path>` under the existing `questions answer` entry, saying the decision is read from the file (`-` for stdin) with its lines kept, and that a `## `/`### ` heading line outside a code fence, or an unclosed fence, is refused.
4. README.md Usage table, "Answer open questions" row: add `--file <path>` (`-` for stdin) to record a multiline decision with its lines kept.

**Files touched.** `src/cli/question-commands.ts`, `src/cli/cli-query-commands.ts`, `src/cli/help.ts`, README.md, `test/question-commands.test.ts`, `test/cli-questions-strictness.test.ts`.

**Acceptance criteria.**
- `test/question-commands.test.ts`: `tryAnswerQuestion(root, 1, "- keep A\n- drop B\n\nbecause X", undefined, true)` moves the block and writes `**Answered <today> by operator:**`, a blank line, then the three decision lines verbatim, and the outcome's `decision` equals that text. With a single-line text and `keepLines` true, the file is byte-identical to the positional answer of the same text. The existing tests (positional fold, placeholder handling, fence refusal) pass unchanged.
- `answerQuestionFromText` refuses a body with a `## Foo` line outside a fence and a body with an unclosed fence (spawned CLI, non-zero exit, message containing `questions answer --file:`), and QUESTIONS.md is unchanged after each. A `## ` line inside a closed fence is accepted and kept.
- `test/cli-questions-strictness.test.ts` (spawned CLI): `questions answer 1 --file ans.md` and `questions answer --file ans.md 1` both record the multiline answer. `questions answer 1 --file ans.md extra` fails with `with --file the decision comes from the file`. A repeated `--file` and `--file=ans.md` are refused. `questions answer --json 1 --file ans.md` prints `{answered, question, decision}` with the kept lines. `questions answer 1 --file -` reads stdin.
- `questions answer 1 "a   b"` still records `a b` (the positional fold is unchanged).
- `npm run test` passes.

### `tumwater plan|bug --edit <n> --file <path>`: rewrite an entry from a markdown file, keeping its line structure (planned 2026-10-12 by plan; sibling of the landed `tumwater plan|bug --file` and the dashboard's line-keeping entry edit (`tryEditEntry`)) — done 2026-10-12

**Goal.** `tumwater plan --file` and `bug --file` file an entry whose body keeps its lines (`splitEntryFile`), and the dashboard drawer edits an entry keeping its lines (`tryEditEntry`). The CLI edit path doesn't keep lines. `editPlan` folds the title and the whole body to one line through `collapseWhitespace`, and `editBug` always writes an empty body. So a multi-line plan filed with `--file` can't be revised from the terminal without flattening it, and `bug --edit` erases the body of a bug filed with `--file`. This plan adds `--file <path>` (`-` reads stdin) to the `--edit` form. The file's first non-blank line becomes the new title and the rest becomes the new body, kept line for line. The entry keeps its position and its original stamp, which is how the existing edit already behaves.

**Approach.**
1. `src/backlog/backlog-write.ts`:
   - Add `editPlanFromText(root, n, text, usage)` and `editBugFromText(root, n, text, usage)`, mirroring `filePlanFromText`/`fileBugFromText`. Each one:
     - runs `splitEntryFile(text)`;
     - fails on an empty title, using the same message the file twin uses (`plan needs a title: ${usage}` / `bug needs a symptom: ${usage}`);
     - runs `bodyStructureProblem(body)` and fails with `the --file body cannot be written: ${problem}`;
     - returns `editEntry(root, "PLANS.md", "Planned", n, title, body)` / `editEntry(root, "BUGS.md", "Open", n, title, body)`.

     For a bug, the body is written as the file gives it. That's deliberate: a bug filed with `--file` can carry a body, and this form is how it gets revised.
   - `editAndAnnounce` gains a trailing parameter `editText: (n: number, text: string) => { file: string; title: string }`. When `args.indexOf("--file") >= 0`, it handles `--file` the way `fileAndAnnounce`'s `--file` branch does:
     - `promptFileValue(args[fileFlag + 1])`, then drop the two tokens into `rest`;
     - `rejectRepeatFlag(rest.includes("--file"), "--file")`;
     - `scanProseFlags(rest, command, { name: "--edit", example: "--edit 2" })`;
     - fail on any positional with `unexpected argument "<tok>" — with --file the entry comes from the file` (the same wording `fileAndAnnounce` uses);
     - fail on a missing position with the existing `--edit needs a position` message;
     - `await requireReadyRepo(root)`, `readPromptFileArg(file)`, then `editText(position, text)`.

     Print the result the same way as the positional form: `edited <command> in <file>: <title>` or the `--json` `{file, title}`. There's no wake.

     The positional form is unchanged. Update the `editAndAnnounce` doc comment to name the `--file` form.
2. `src/cli.ts`: in the `bug` and `plan` cases, the `--edit` branch passes `(n, text) => editBugFromText(root, n, text, usage)` / `(n, text) => editPlanFromText(root, n, text, usage)` as the new argument, and adds both names to the destructured dynamic import.
3. `src/cli/help.ts`: add `tumwater bug --edit <n> --file <path> [--json]` and `tumwater plan --edit <n> --file <path> [--json]` entries after each command's existing `--edit` entry. Each says: replace the Nth entry from a markdown file (`"-"` reads stdin), the first non-blank line is the title (symptom for bugs) and the rest is the body kept line for line, the position and original stamp are kept, and there's no wake.

**Files touched.** `src/backlog/backlog-write.ts`, `src/cli.ts`, `src/cli/help.ts`, `test/backlog-write-edit.test.ts`. No change to `tryEditEntry`, `handleBacklogEdit`/the dashboard, or the TUI. This plan is independent of the waiting TUI answer plan, which touches only `src/ui/tui/*`.

**Acceptance criteria.** All tests go in `test/backlog-write-edit.test.ts`, using its `makeRepo`/`initProject`/`cli` helpers.
- Seed PLANS.md `## Planned` with three entries. Then run `cli(repo, "plan", "--edit", "2", "--file", md)`, where the file holds `# New title\n\n- one\n\n- two\n`. The run exits 0 and prints `edited plan in PLANS.md: New title`. The second entry becomes `### New title (<its original stamp>)` followed by `- one\n\n- two`, with the inner blank line kept. Entries 1 and 3 are byte-identical, and `queuedRolePrompts(repo, "feature")` is empty.
- `bug --edit 1 --file <md> --json` prints `{file: "BUGS.md", title}`, and the entry's body is written line for line. A later positional `bug --edit 1 "x"` still drops that body, which pins the unchanged positional behavior.
- Each of these refusals exits 1 and leaves PLANS.md byte-identical:
  - a body with a bare `## Heading` line (stderr matches `cannot be written`);
  - a body that leaves a code fence open;
  - a whitespace-only first line followed by nothing (the existing empty-file refusal);
  - `--edit 9 --file md` (out of range);
  - `--edit 2 --file md extra` (stray-argument message);
  - `--file md --file md` (`--file may only be given once`);
  - `--edit 2 --file` (`--file needs a path`).
- The "help topics name the --edit forms" test also matches `tumwater plan --edit <n> --file <path> \[--json\]` and the bug twin.
- `npm run test` passes.

### Give the dashboard's New plan / File a bug form an optional multiline body, matching `tumwater plan|bug --file` (planned 2026-10-12 by plan; sibling of the landed `tumwater plan|bug --file` (`splitEntryFile`, `filePlanFromText`, `fileBugFromText` in `src/backlog/backlog-write.ts`) and the landed drawer edit (`POST /api/backlog-edit`, `handleBacklogEdit`). Independent of the waiting "Answer an open question from the TUI backlog pane" plan: it touches neither `src/ui/tui/` nor `src/cli/`) — done 2026-10-12

**Goal.** The dashboard's Plans/Bugs tabs have a New control (`POST /api/backlog-file`, `handleBacklogFile` in `src/gui/gui-endpoint-commands.ts`). It takes a title only, so an operator filing from the dashboard can't add a goal, approach, or repro steps. They have to file the title and then reopen the entry in the drawer to edit the body. The CLI's `--file` form already files a title plus a body kept line for line, checked by `bodyStructureProblem`. This plan gives the dashboard form an optional **Details** textarea that goes through the same validation and write path.

**Approach.**
1. `src/backlog/backlog-write.ts`:
   - Extract the body normalization out of `splitEntryFile` into an exported `normalizeEntryBody(body: string): string`. It converts CRLF to LF, trims trailing whitespace on each line, and drops leading and trailing blank lines (`trimLeadingBlankLines` / `trimTrailingBlankLines`). `splitEntryFile` then calls it on the lines after the title, and its existing tests must stay green unchanged.
   - Add an exported non-exiting `fileEntryWithBody(root: string, kind: "bug" | "plan", title: string, body: string): FiledEntry`. It calls `appendOperatorEntry` with PLANS.md / `PLANS_TEMPLATE` / `"Planned"` for a plan and BUGS.md / `BUGS_TEMPLATE` / `"Open"` for a bug, writing `title` through `collapseWhitespace` and `body` as given. The caller has already validated the title (non-empty) and the body (`bodyStructureProblem`). Doc comment: shared by the `--file` forms and the dashboard file endpoint. `filePlanFromText` and `fileBugFromText` keep their `fail()` checks and then call `fileEntryWithBody` instead of `appendOperatorEntry` directly.
2. `src/gui/gui-endpoint-commands.ts`, `handleBacklogFile`: accept an optional `body` field (the JSON request body's `body` key; read it as `const rawBody = body.body`). Update the doc comment and the `readPostBody` example to `{"kind": "plan", "title": "...", "body": "optional markdown"}`.
   - If `rawBody` is neither `undefined` nor a string, return 400 `body must be a string`.
   - Otherwise `const entryBody = normalizeEntryBody(rawBody ?? "")`. If `bodyStructureProblem(entryBody)` is non-null, return 400 with that message, after the existing title and wake-length checks and before anything is written.
   - Replace the `fileBug`/`filePlan` call with `fileEntryWithBody(root, kind, rawTitle, entryBody)`. The wake text, the `submitRolePromptAndWake` call, and the 200 reply shape `{ ok, file, title }` stay as they are. Drop `fileBug`/`filePlan` from the import if nothing else in the file uses them (check with grep).
3. `src/ui/gui/gui-client-fleet.ts`, `renderBacklog`'s New-form markup (the `backlogNew && backlogNew.kind === kind` branch): after the `<input id='backlognew'>`, add `<textarea id='backlognewbody' rows='6' placeholder='Details (optional, markdown)'></textarea>`. The Save handler (the `backlognewsave` click branch) posts `{ kind, title, body: bodyBox ? bodyBox.value : "" }` with `const bodyBox = $("backlognewbody")`. The existing `backlogNewPainted` guard already keeps a poll from repainting the open form, so typed details survive polls.
4. README.md Usage "Steer the project" row: where the sentence says the dashboard's plan/bug drawer edits an entry, add a short clause saying the Plans/Bugs tabs' New form files one with an optional markdown body.

**Files touched.** `src/backlog/backlog-write.ts`, `src/gui/gui-endpoint-commands.ts`, `src/ui/gui/gui-client-fleet.ts`, `README.md`, `test/gui-endpoints.test.ts`, `test/gui-client-fleet.test.ts`, `test/backlog-write.test.ts`.

**Acceptance criteria.**
- `test/gui-endpoints.test.ts`: a new test beside "handleBacklogFile files a bug or plan and wakes its loop, and 400s bad input untouched", using `serveBacklogFile`:
  - `{ kind: "plan", title: "add z", body: "Goal.\r\n\r\n- a  \n- b\n\n" }` answers 200, and PLANS.md holds `### add z (reported by the operator …)` followed by the body `Goal.\n\n- a\n- b` line for line (CRLF converted, trailing spaces and the trailing blank lines gone). The feature inbox gets `planWakeText("add z")`.
  - A bug with a body lands its body under BUGS.md's `## Open` the same way.
  - `{ kind: "bug", title: "x", body: "### phantom" }`, `{ kind: "plan", title: "x", body: "```\nunclosed" }`, and `{ kind: "plan", title: "x", body: 7 }` each answer 400, leave both files byte-identical, and queue no wake.
  - The existing title-only cases still pass unchanged, so an omitted `body` files an empty-bodied entry as before.
- `test/backlog-write.test.ts`: `normalizeEntryBody` converts CRLF, trims trailing whitespace on each line, and drops edge blank lines while keeping inner blank lines. The existing `splitEntryFile` and `filePlanFromText` tests pass unchanged.
- `test/gui-client-fleet.test.ts`: "the Plans and Bugs tabs offer a New form…" also asserts the open form's HTML contains `<textarea id='backlognewbody'`, and that a poll still keeps the form byte-identical. `GUI_CLIENT_FLEET_JS` matches `/body: bodyBox \? bodyBox\.value : ""/` (or an equivalent check that the Save post carries the textarea's value).
- `npm run test` passes.

### File a structured plan request or bug report from a markdown file: `tumwater plan --file <path>` and `tumwater bug --file <path>` (`-` reads stdin), keeping the body's line structure (planned 2026-10-12 by plan; sibling of the landed `tumwater prompt --file` (`parsePromptArgs`' `--file` branch in `src/cli/cli-command-args.ts`) and the landed `tumwater plan|bug` file forms (`fileAndAnnounce`, `filePlan`, `fileBug` in `src/backlog/backlog-write.ts`). Independent of both waiting TUI plans: it touches neither `src/ui/tui/` nor the GUI) — done 2026-10-12

**Goal.** The brief says the operator "only write[s] the markdown/initial prompt". But the CLI can't file a markdown plan request with any structure. `filePlan` folds its body through `collapseWhitespace`, so a request with Goal / Approach paragraphs or a bullet list lands as one long line. `fileBug` writes no body at all, so repro steps either get crammed into the heading or lost. `tumwater prompt --file` already reads a prompt from a file or stdin. This plan gives `plan` and `bug` the same `--file <path>` form. The file's first non-blank line is the title. Every line after it is the entry body, kept line for line, and checked by the same `bodyStructureProblem` guard the dashboard's in-place edit uses, so a `## `/`### ` line or an unclosed fence can't grow a phantom section.

**Approach.**
1. `src/cli/cli-command-args.ts`: move the stdin-or-path read from `parsePromptArgs`' `--file` branch into one exported function, `readPromptFileArg(file: string): string`. For `file === "-"` it uses the module-level `stdinPrompt` memo exactly as today (read once, read error `cannot read prompt file "-" (stdin): …`, then `failEmptyPromptFile`). Any other path goes through `readPromptFileChecked`. `parsePromptArgs` then calls it, with unchanged behavior and messages. Also export `promptFileValue`, so the backlog parser reuses the `--file needs a path` refusal.
2. `src/backlog/backlog-write.ts`:
   - `export function splitEntryFile(text: string): { title: string; body: string }`. Normalize `\r\n` to `\n`. The title is the first line whose trim is non-empty, with any leading `#{1,6} ` marker stripped (so a file that opens with `# My plan` or `### My plan` files as `My plan`), then folded through `collapseWhitespace`. The body is every line after the title line, with leading and trailing blank lines dropped (`trimLeadingBlankLines`/`trimTrailingBlankLines` from text.ts) and trailing whitespace stripped from each line. Interior lines are otherwise kept as written. If the title line is the only line, the body is `""`.
   - `export function filePlanFromText(root, text, usage)` and `export function fileBugFromText(root, text, usage)`. Each calls `splitEntryFile`. An empty title fails with `plan needs a title: <usage>` / `bug needs a symptom: <usage>`, matching `filePlan`/`fileBug`. A non-null `bodyStructureProblem(body)` fails as `the --file body cannot be filed: <problem>` and writes nothing. Otherwise the function calls `appendOperatorEntry` with the kept body (`PLANS.md`/`PLANS_TEMPLATE`/`Planned`, or `BUGS.md`/`BUGS_TEMPLATE`/`Open`). `appendEntryLocked` already writes a multi-line body as-is.
   - `fileAndAnnounce` gains one trailing parameter, `fileText: (text: string) => FiledEntry`. When `args` holds `--file`:
     - take its value with `promptFileValue(args[i + 1])`, remove that pair from the args, and pass the rest to `scanProseFlags`. A second `--file` fails through `rejectRepeatFlag`.
     - any leftover positional fails as `unexpected argument "<tok>" — with --file the entry comes from the file`.
     - after `requireReadyRepo`, read with `readPromptFileArg`, then run the `promptLengthProblem` preflight on `wakeText(splitEntryFile(text).title)` before any write. The wake prompt's title comes from the same split the write uses.
     - then `filed = fileText(text)`, followed by the same wake and the same `sayFiled` as the positional form.
     Without `--file`, the path is unchanged. Update `fileAndAnnounce`'s doc comment to match.
3. `src/cli.ts`: in the `bug` and `plan` cases, pass `(text) => fileBugFromText(root, text, usage)` / `(text) => filePlanFromText(root, text, usage)` as the new argument. `--list`/`--edit`/`--cancel` are dispatched first and stay unchanged, so `plan --edit 2 --file x` keeps failing through `scanProseFlags`' unknown-flag refusal. `--file` on `--edit` is out of scope.
4. `src/cli/help.ts`:
   - add stanzas `tumwater bug --file <path> [--json]` and `tumwater plan --file <path> [--json]` beside the existing file forms. Each says the first non-blank line is the title, the rest is the body kept line for line, `-` reads stdin, and the loop is woken.
   - add `"--file"` to `FREEFORM_VALUED_FLAGS.bug` and `.plan`, and fix that constant's doc comment, which says "bug/plan's only valued flag is `--cancel`".
5. README.md, "Steer the project" row: after the `tumwater plan "<title>" [body...]` clause, add "— or `--file <path>` (`-` for stdin) to file one from a markdown file, its first line the title and the rest the body, kept line for line". Keep it to that clause.

**Files touched.** `src/cli/cli-command-args.ts`, `src/backlog/backlog-write.ts`, `src/cli.ts`, `src/cli/help.ts`, `README.md`, `test/backlog-write.test.ts`, `test/cli-command-args.test.ts` (only if an existing prompt `--file` test needs its import adjusted), `test/help.test.ts` (it already covers `helpTopicForArgs`). Not touched: the dashboard's `handleBacklogFile`, `filePlan`/`fileBug` (the positional forms keep folding to one line).

**Acceptance criteria.**
- `test/backlog-write.test.ts`, `splitEntryFile`: `"# Title\n\nGoal.\n\n- a\n- b\n"` gives `{ title: "Title", body: "Goal.\n\n- a\n- b" }`. Leading blank lines before the title are skipped. A CRLF file splits the same as its LF twin. A title-only file gives body `""`.
- `filePlanFromText` on a temp root writes a `### <title> (reported by the operator <date>)` heading under `## Planned` followed by the body line for line: a bullet list stays on separate lines. `plannedPlanEntries` (`src/backlog/backlog.ts`) reads back exactly one new entry, and its body holds the list.
- `fileBugFromText` writes the heading plus body under BUGS.md `## Open` the same way, and `openBugEntries` reads it back as one entry.
- A body holding a `## Heading` line outside a fence, or an unclosed fence, fails with `the --file body cannot be filed:` and leaves PLANS.md byte-identical. A fenced `## ` line inside the body is accepted and kept.
- An empty or whitespace-only title fails with the kind's existing usage message and writes nothing.
- Through `fileAndAnnounce` (the existing tests' harness for the file forms): `--file` plus a stray positional fails naming the token and writes nothing. `--file` with no value fails `--file needs a path`. `--file` given twice is refused. A missing file fails with `cannot read prompt file`.
- `parsePromptArgs`' existing `--file` tests pass unchanged.
- `helpTopicForArgs("plan", ["--file", "x.md", "--help"])` returns the plan topic, and `helpTopic("plan")` includes the `--file` stanza.
- `npm run test` passes.

### Cancel a planned feature or open bug from the TUI backlog pane, matching `tumwater plan|bug --cancel <n>` and the dashboard drawer's Cancel (planned 2026-10-12 by plan; sibling of the landed CLI `tumwater plan|bug --cancel` (`cancelPlan`/`cancelBug` in `src/backlog/backlog-write.ts`) and the landed drawer Cancel (`POST /api/backlog-cancel`, `handleBacklogCancel` in `src/gui/gui-endpoint-commands.ts`, both calling `tryCancelEntry`). Independent in behavior of the waiting "Answer an open question from the TUI backlog pane" plan (that one handles questions with Ctrl+A, this one handles plans/bugs with Ctrl+X). Both add branches and guards to `createTuiKeys` in `src/ui/tui/tui-keys.ts` and a hint to `hintLine`, so a landing conflict is possible and the resolver handles it. Independent of the waiting dashboard-drawer edit plan: this plan calls `tryCancelEntry` as it stands and does not change `backlog-write.ts`) (done 2026-10-12)

**Goal.** In the TUI's project-status (backlog) pane, the operator can open a plan or bug in full (Up/Down set `selectedEntry`) but cannot retract it. Today that means switching to the CLI or the dashboard. With a plan or bug selected, **Ctrl+X** arms a cancel and a second **Ctrl+X** confirms it. That is the TUI version of the drawer's confirming second click. Any other key disarms. The write goes through the same non-exiting core the dashboard uses, so a stale selection can never remove the wrong entry.

**Approach.**
1. `src/ui/tui/tui-keys.ts`, `createTuiKeys`:
   - state `let cancelArmed: { kind: "plan" | "bug"; position: number; title: string } | null = null`.
   - At the very top of `handleKey`, before the Ctrl+D branch: `const armed = cancelArmed; cancelArmed = null;`. Every key, including the second Ctrl+X, starts out disarmed. Only the confirming branch below reads `armed`. So "any other key disarms" holds by construction and no other branch has to clear the arm.
   - A new branch `key.ctrl && key.name === "x" && view === roleIds.length + 1` placed right after the existing Queued-pane Ctrl+X branch (that branch is guarded to `view === roleIds.length + 6`, so the two never overlap). Guard it with none of `budgetMode`, `rolePromptFor`, `searchMode`, `deferMode`, `queuedEditFor` set. If the answer plan has landed, add `answerFor` to that list too; grep `queuedEditFor` to find the editor list as it stands. In list mode (`selectedEntry === null`), do nothing and render. Otherwise resolve the selection the way the PgUp/PgDn entry branch does: `const entries = flat(); const sel = Math.min(selectedEntry, entries.length - 1)`. Then:
     - `entries[sel].label === "question"`: flash `only a plan or open bug can be cancelled here` and stay disarmed.
     - otherwise `kind = label` (`"plan"` or `"bug"`). Compute `position`, the 1-based index within its own section: for a plan, `sel + 1`; for a bug, `sel - entries.filter((e) => e.label === "plan").length + 1`. This works because `labeledBacklogEntries` (`tui-backlog.ts`) lists plans, then bugs, then questions. Set `target = { kind, position, title: entries[sel].title }`. `BacklogEntry.title` and `tryCancelEntry`'s `entry.title` both come from `headingTitle(line, "### ")`, so they are the same string.
     - If `armed` deep-equals `target` (same kind, position, and title), this is the confirm. Call `tryCancelEntry(root, kind, position, title)` (import it from `../../backlog/backlog-write.js`):
       - `cancelled`: `selectedEntry = null`, `entryScroll = 0`, flash `cancelled <kind> #<position>: <title>`.
       - `gone` / `moved`: `selectedEntry = null`, `entryScroll = 0`, flash `that <kind> was already removed or moved — nothing cancelled`.
       - a throw: `flashError(err)`.
     - Otherwise, arm: `cancelArmed = target`, then flash `press Ctrl+X again to cancel <kind> #<position> — any other key keeps it`.
     - `deps.requestRender(); return;`
   - Expose `cancelArmed` on the `TuiKeys` state interface (doc comment beside `selectedEntry`) and in the returned `state()` object, so tests can observe the arm.
   - No wake, the same as the CLI's `--cancel` and the dashboard.
2. `src/ui/tui/tui-frame.ts`, `hintLine`: in the `view.kind === "backlog"` hint, add `["Ctrl+X", "cancel entry"]` after `["↑↓", "open entries"]`. If the answer plan landed first, put it after that plan's `["Ctrl+A", "answer question"]`.
3. README.md: the "Steer the project" row's closing clause, "the dashboard's plan/bug drawer cancels an entry the same way, after a confirming second click", gains "and the TUI's backlog pane does too, with Ctrl+X pressed twice on the selected entry". Keep it short.

**Files touched.** `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `README.md`, `test/tui-keys.test.ts`, `test/tui-frame.test.ts`. No change to `src/backlog/backlog-write.ts` (`tryCancelEntry` already holds the primary-worktree lock and refuses `gone`/`moved` as data) and none to `tui.tsx` (no new prompt-line mode).

**Acceptance criteria.**
- In `test/tui-keys.test.ts`, using the file's `makeRoot`/`makeKeys` helpers and a temp root whose PLANS.md has two planned entries and BUGS.md has two open bugs: Ctrl+T to the backlog view, then Down until the second bug is selected. Press Ctrl+X once. `state().cancelArmed` deep-equals `{ kind: "bug", position: 2, title: <second bug's heading> }`, BUGS.md is byte-identical, and the flash matches `/press Ctrl\+X again/`. Press Ctrl+X again. BUGS.md loses exactly that entry (the first bug and PLANS.md are unchanged), `cancelArmed` and `selectedEntry` are null, and the flash matches `/cancelled bug #2/`.
- Arm on the first plan, then press any other key (for example a typed letter, or Up). `cancelArmed` is null, and a following single Ctrl+X only re-arms: PLANS.md stays byte-identical.
- Ctrl+X with a question selected flashes `only a plan or open bug can be cancelled here` and writes nothing. Ctrl+X in list mode (`selectedEntry` null) writes nothing and leaves `cancelArmed` null.
- Arm on plan #1, then rewrite PLANS.md so a different heading sits at position 1, then press Ctrl+X. PLANS.md is byte-identical to the rewritten content, the flash matches `/already removed or moved/`, and `selectedEntry` is null.
- While the budget editor (Ctrl+B) is open on the backlog view, Ctrl+X neither arms nor writes.
- The existing Queued-pane Ctrl+X test still passes unchanged.
- `test/tui-frame.test.ts`: the backlog-view `hintLine` names `Ctrl+X` with `cancel entry`.
- `npm run test` passes.

### Edit a planned feature or open bug from the dashboard's entry drawer, matching `tumwater plan|bug --edit <n>` (planned 2026-10-12 by plan; sibling of the landed CLI `tumwater plan|bug --edit` (`editPlan`/`editBug` → `editEntry` in `src/backlog/backlog-write.ts`) and the landed drawer Cancel (`tryCancelEntry` + `POST /api/backlog-cancel` + the `entry-cancel` act). The drawer can file, cancel, or "ask the director about" an entry but not correct one, so fixing a typo'd title or a stale acceptance criterion means switching to the CLI, finding its position, and retyping the whole body on one line. Independent in behavior of the two waiting scheduled-wake plans: its own core, route, handler, and drawer form. It shares `src/gui/gui-server.ts`'s route table and `src/gui/gui-endpoint-commands.ts` with them, so a landing conflict is possible and the resolver handles it); done 2026-10-12 by feature

**Goal.** The plan/bug entry drawer gets an "Edit" button. It opens a form prefilled with the entry's title and full Markdown body. Saving rewrites the entry in place under the same lock as `--edit`. The entry keeps its position and its original `(planned …)`/`(reported …)` stamp. It also keeps its body's line structure: the CLI's `editPlan` folds the body to one line with `collapseWhitespace`, which would flatten a structured plan, so the dashboard path does not reuse that fold. Like Cancel, the save is title-checked: if the list moved since the drawer loaded, the save writes nothing.

**Approach.**
1. `src/backlog/backlog-write.ts`:
   - Export `bodyStructureProblem(body: string): string | null`. It walks `body.split("\n")` with a fresh `fenceTracker()` (from `backlog-md.ts`). It returns a message when any line yields a heading through `fencedHeadingTitle(line, tracker, "## ")` or `"### "`: "the body may not contain a `## `/`### ` heading line outside a code fence". It also returns a message when `tracker.open()` is still true at the end: "the body leaves a code fence open". Otherwise it returns null. Either problem would make `actionableEntryRanges` misread the following entries or sections.
   - Export `type EditEntryOutcome = { status: "edited"; file: string; title: string } | { status: "gone" } | { status: "moved"; title: string }`, the `CancelEntryOutcome` shape.
   - Export `tryEditEntry(root, kind: "bug" | "plan", n, expectedTitle, rawTitle, rawBody): EditEntryOutcome`. It mirrors `tryCancelEntry`: take the same `withStateLock(primaryWorktreeLockPath(root), …)`, use `findEntry` for `gone`, and compare `entry.title !== expectedTitle` for `moved`. On a match it performs the same splice `editEntryLocked` does. Refactor that splice out of `editEntryLocked` into a shared `spliceInEditedEntry(file, lines, entry, title, body)`, the way `spliceOutEntry` is shared by remove and cancel, so the two paths cannot drift. The title is `stripEntryStamp(collapseWhitespace(rawTitle))`, so a pasted stamp is never doubled. The body is `rawBody.replace(/\r\n?/g, "\n").trim()` with no whitespace collapse. A bug's body is written as given (`""` keeps the heading-only shape `editBug` writes).
   - `tryEditEntry` trusts its caller to have validated. The handler does all validation before calling it, because `fail()` exits the process.
2. `src/gui/gui-endpoint-commands.ts`: add `handleBacklogEdit` for `POST /api/backlog-edit`, modeled on `handleBacklogCancel`.
   - The body is `{kind, position, title, newTitle, newBody}`. Validate `kind`, `position`, and `title` with the same 400s as cancel.
   - `newTitle` must be a string that is non-empty after `collapseWhitespace`, else 400 "newTitle required".
   - `newBody` must be a string (`""` is allowed), else 400. When `bodyStructureProblem(newBody)` returns a message, answer 400 with it.
   - Wrap `tryEditEntry` in try/catch, sending 400 with `errorMessage` on a throw. Answer `{ok:true, status:"edited", file, title}` or `{ok:true, status:"gone"}`, folding `moved` into `gone` as cancel does.
   - No wake and no inbox prompt: the waiting entry is refined by whichever feature/bugfix tick picks it up.
   - Register the route in `src/gui/gui-server.ts` next to `"POST /api/backlog-cancel"`.
3. `src/ui/gui/gui-client-drawer.ts`, in `refreshEntry` and the drawer's state:
   - Add `let entryEditing = null; // { key, title }`. Add an "Edit this entry" button (`data-act='entry-edit' data-arg='<file>:<index>'`) beside "Cancel this entry" for plans and bugs.
   - While `entryEditing.key === openEntryKey()`, `refreshEntry` paints `entrybody` with a form instead of the read view: `<input id='entryedittitle'>` prefilled with `esc(splitTitle(d.title).title)`, `<textarea id='entryeditbody' rows='14'>` prefilled with `esc(d.body)`, a primary "Save" (`data-act='entry-edit-save'`), and "Discard" (`data-act='entry-edit-discard'`).
   - The form is painted once when editing starts. Later polls return after the head without repainting `entrybody`, so the operator's draft survives the poll even if the entry changes on disk; the title check catches that case at save time.
   - `closeDrawer` and opening another entry clear `entryEditing`. Expose `entryEditing` setters (`startEntryEdit(key, title)` and `stopEntryEdit()`) the way `armEntryCancel`/`disarmEntryCancel` are.
4. `src/ui/gui/gui-client-boot.ts` `runAct`:
   - `entry-edit` looks up the title in `lastStatus[file]` and calls `startEntryEdit(arg, title)`.
   - `entry-edit-discard` calls `stopEntryEdit()`.
   - `entry-edit-save` reads `$("entryedittitle")`/`$("entryeditbody")`. When the trimmed title is empty it calls `showFlash("Write a title first")` and posts nothing. Otherwise it posts `/api/backlog-edit` with `{kind, position: index+1, title: <status title>, newTitle, newBody}`. Its callback calls `stopEntryEdit()` and `closeDrawer()` and returns "Edited “<title>” in PLANS.md|BUGS.md", or "That entry was removed or moved — refreshed" on `gone`.
5. README: in the "Steer the project" row, extend the closing clause "the dashboard's plan/bug drawer cancels an entry the same way, after a confirming second click". It should also say the drawer edits an entry's title and body in place.

**Files.** `src/backlog/backlog-write.ts`, `src/gui/gui-endpoint-commands.ts`, `src/gui/gui-server.ts`, `src/ui/gui/gui-client-drawer.ts`, `src/ui/gui/gui-client-boot.ts`, `README.md`, and tests beside the `tryCancelEntry` tests in `test/backlog-write-cancel.test.ts`, `test/gui-endpoints.test.ts` (next to the `POST /api/backlog-cancel` block), and `test/gui-client-boot.test.ts` (next to the `entry-cancel` runAct test).

**Acceptance criteria.**
- `tryEditEntry` on the 2nd of three Planned entries replaces that entry's heading and body. It keeps the original stamp parenthetical and a multi-line body's newlines. The bytes of the other entries and of `## Done` are unchanged, and the result equals what `editPlan` writes for a single-line body.
- A submitted title that already ends in a stamp is not doubled.
- `tryEditEntry` answers `gone` for an out-of-range position and `moved` for a different heading, and leaves the file byte-identical in both cases.
- `bodyStructureProblem` returns null for a body quoting `## X`/`### Y` inside a closed fence. It returns a message for a bare `### Y` line and for an unclosed fence.
- `POST /api/backlog-edit`:
  - answers 400 for a bad kind, position, title, empty newTitle, non-string newBody, or a structure problem, writing nothing;
  - answers 200 `edited` and rewrites PLANS.md;
  - answers 200 `gone` on a moved list;
  - queues no inbox prompt and writes no wake marker.
- The runAct test:
  - `entry-edit` starts editing for `plans:1`;
  - `entry-edit-save` with a blank title posts nothing;
  - a filled save posts `["/api/backlog-edit", {kind:"plan", position:2, title:<status title>, newTitle, newBody}]`.
- `npm run test` passes.

### Keep every pending scheduled wake: a later `wake` or dashboard prompt no longer silently drops a `wake --in` (planned 2026-10-12 by plan; fixes a latent overwrite in the landed `tumwater wake --in` / dashboard "Wake later". `.tumwater/wake.json` (`wakeRequestPath` in `src/paths.ts`) holds ONE request, and `requestWake` in `src/operator/operator-intent.ts` replaces it with `writeJsonAtomic`. So `wake feature --in 2h` followed by any immediate wake drops the scheduled one with no message. That includes `submitRolePromptAndWake`, which every dashboard/TUI prompt submit calls. A second `wake plan --in 1h` drops it the same way. Sibling of the waiting "Show a pending scheduled wake in `tumwater status`…" plan above: that plan's reader moves to this plan's directory if this lands first (see step 5). Independent of the entry-drawer cancel plan); done 2026-10-12 by feature

**Goal.** Each scheduled wake is its own marker file, so it survives every later wake request, immediate or scheduled, until its deadline passes and a live fleet applies it. Immediate wakes keep today's `wake.json` path, contract, and wording unchanged.

**Approach.**
1. `src/paths.ts`: add `export function scheduledWakeDir(root: string): string`, which returns `path.join(tumwaterDir(root), "wakes")`. Its doc comment should say that each file in it is one scheduled wake (`{ at, roles, notBeforeMs }`), and that a file per request is what keeps a later request from overwriting a pending one.
2. `src/operator/operator-intent.ts`, `requestWake`: on the `deferred` branch, write the marker to `path.join(scheduledWakeDir(root), `${now}-${process.pid}-${crypto.randomBytes(4).toString("hex")}.json`)` (mkdir `recursive` first) instead of `wakeRequestPath(root)`. The non-deferred branch is unchanged. Update the stale comment above the write: the "torn marker drops notBeforeMs" rationale still holds per file. The return wording is unchanged.
3. `src/operator/operator-requests.ts`: extract the body of `consumeWakeRequest` after the deadline check (the `roleRequestTargets` → `r.wake()` → `runnerlessTargets` → `removeQuiet` sequence) into a private `applyWakeMarker(root, markerFile, runners)`. `consumeWakeRequest` then does three things:
   - It keeps handling `wake.json` exactly as today. That includes its `notBeforeMs` check, because a marker written by the pre-upgrade build may still carry a deadline.
   - It reads `scheduledWakeDir(root)` (a missing dir is a no-op), takes only names ending in `.json` (this skips `writeTextAtomic`'s `.tmp-<pid>` files), and sorts them.
   - For each file, it applies the wake through `applyWakeMarker` when the marker is corrupt (the same wake-every-runner policy `wake.json` has) or when `notBeforeMs` is missing, non-finite, or `<= Date.now()`. A future deadline leaves the file in place.

   No lock is needed: writers only create new files, and only the consumer deletes them.
4. Add `export function pendingScheduledWakes(root: string, now: number): { roles: string[]; atMs: number }[]` to `src/operator/operator-requests.ts`. It is a pure reader: well-formed future entries only (roles a non-empty all-string array, the `requestedRoles` shape check), sorted by `atMs` ascending, and nothing deleted. This plan uses it only in its tests. It exists so the display plan has one reader of the format.
5. Sibling hand-off: if the display plan's `scheduledWake` in `src/fleet/fleet-state.ts` has already landed, rewrite its body in this change to return the earliest entry of `pendingScheduledWakes(root, now)`, keeping a legacy future-deadline `wake.json` as a fallback. If it has not landed, edit that plan's step 1 in PLANS.md in this change so it builds on `pendingScheduledWakes` instead of reading `wake.json`. Its "Out of scope: the marker holds one wake" paragraph also goes, since this plan fixes that.
6. README "Control the loops" row: add one clause after the `wake --in 45m` sentence saying that each scheduled wake stands on its own, so later wakes do not cancel it.

Out of scope: two immediate wakes inside one poll (~2 s) still share `wake.json`, so the second one's role list replaces the first's. The window is one poll long and the dropped wake's loop still wakes on its own backoff.

**Files touched.** `src/paths.ts`, `src/operator/operator-intent.ts`, `src/operator/operator-requests.ts`, README.md, and possibly `src/fleet/fleet-state.ts` (step 5). The tests that read a scheduled marker through `wakeRequestPath` move to the new directory: `test/cli-operators.test.ts` (`wake --in`), `test/gui-operator.test.ts` (`inSeconds`), `test/operator-commands.test.ts`, and `test/operator-intent.test.ts` (the `wake.json` read with `notBeforeMs`, and the corrupt-superset test that asserts `notBeforeMs` survives). Find them with `grep -rn 'notBeforeMs' test | grep -v -i prompt`. New consumer tests go in `test/operator-requests.test.ts`.

**Acceptance criteria.**
- `requestWake(root, ["feature"], 3_600_000)` followed by `requestWake(root, ["plan"])` leaves one file in `scheduledWakeDir(root)` carrying `notBeforeMs`, and `wake.json` without `notBeforeMs`. Two scheduled requests leave two files.
- `consumeWakeRequest`:
  - It wakes the `plan` runner and removes `wake.json`, but leaves the scheduled file and does not wake `feature`.
  - With the scheduled file's `notBeforeMs` rewritten into the past, the next call wakes `feature`, logs its `wake` event with `reason: "operator"`, and removes the file.
  - A corrupt `.json` file in the dir wakes every runner and is removed.
  - A `*.json.tmp-123` file is ignored and left in place.
  - A legacy `wake.json` with a future `notBeforeMs` is still left in place, as today.
- `pendingScheduledWakes` returns future entries sorted by `atMs`. It skips past-deadline and corrupt entries without deleting them.
- `submitRolePromptAndWake` after a `wake feature --in 1h` leaves the scheduled file in place (pinned in `test/operator-intent.test.ts`).
- `npm run test` passes.

### Show a pending scheduled wake in `tumwater status`, the TUI header, and the dashboard's loop rows (planned 2026-10-12 by plan; sibling of the landed CLI `tumwater wake --in <duration>` (`requestWake(root, roles, inMs)` in `src/operator/operator-intent.ts` writes `{ at, roles, notBeforeMs }` to `wakeRequestPath`, `.tumwater/wake.json`) and the landed dashboard "Wake later" menu (`wakeLater` in `src/ui/gui/gui-client-loops.ts`). Once a wake is scheduled, the only code that reads the marker is `consumeWakeRequest` in `src/operator/operator-requests.ts`, which applies it. No status surface shows that a wake is pending, so an operator who scheduled "wake in 2h" has no way to confirm it, and no way to see when it will fire. The timed pause already shows its countdown (`pauseBadge` in `src/ui/badges.ts`, and the `resumes in` row note in `phaseDetail`). This plan gives the scheduled wake the same treatment. It is independent of the waiting entry-drawer cancel and loop-drawer wake-later plans in behavior: it is read-only and adds no route or action. It does share `src/ui/gui/gui-client-loops.ts` with the wake-later plan, so a landing conflict is possible and the resolver handles it) (done 2026-10-12 by feature)

**Goal.** While a scheduled wake is pending, three surfaces say so: `tumwater status` (and the TUI, which renders the same header) shows ` · wake scheduled in 45m (feature, plan)`, `status --json` and `GET /api/status` carry the raw `scheduledWake: { roles, atMs }`, and each dashboard loop row that the wake targets adds ` · operator wake in 45m` to its status pill's second line. When no wake is pending, every surface stays exactly as it renders today.

**Approach.**
1. `src/fleet/fleet-state.ts` (it already reads the fleet's operator markers: `pausedUntil`, `pausedRolesUntil`): add `export function scheduledWake(root: string, now: number): { roles: string[]; atMs: number } | undefined`. It reads `wakeRequestPath(root)` (import it from `../paths.js`) with `readJsonFile`. It returns a value only when the marker parses, `roles` is a non-empty array whose every element is a string (the same shape check as `requestedRoles` in `src/operator/operator-requests.ts`; do not use `stringList`, which silently drops non-string elements instead of rejecting the marker), and `notBeforeMs` is a finite number greater than `now`. It returns undefined for everything else: an immediate wake (no `notBeforeMs`), an expired deadline (the consumer applies that one within a poll), a corrupt marker, or a missing file. This function is a pure reader, so it never deletes or rewrites the marker (only `consumeWakeRequest` removes it).
2. `src/status/status-data.ts`: add `scheduledWake?: { roles: string[]; atMs: number }` to `StatusSnapshot`, with a doc comment in the `pausedRolesUntil` style. Fill it in `snapshot()` beside `pausedRolesUntil: pausedRolesUntil(root)` as `scheduledWake: scheduledWake(root, now)`, using the snapshot's pinned `now` seam rather than `Date.now()`.
3. `src/ui/status-payload.ts` (`statusPayload`): add `scheduledWake: snap.scheduledWake` beside `pausedRolesUntil`, using the same omit-undefined idiom.
4. `src/ui/badges.ts`: add `export function wakeBadge(wake: { roles: string[]; atMs: number } | undefined, now: number): string`. It returns `` ` · wake scheduled in ${humanSeconds(secondsUntil(wake.atMs, now))} (${wake.roles.join(", ")})` `` while `wake` is set and `atMs > now`, and `""` otherwise. Its doc comment should say why it exists: a scheduled wake is otherwise invisible. `src/ui/status-render.ts`: right after the `pauseBadge(...)` span in the header, add `...badgeSpans(wakeBadge(snap.scheduledWake, now), "blue")` (the informational tone the landing and bootstrap badges use).
5. `src/ui/gui/gui-client-loops.ts`, `phaseDetail(l, info, d)`: compute the detail as today. Then, when `d.scheduledWake` is set, its `atMs > Date.now()`, and its `roles` include `l.role` or `l.instanceOf` (the consumer matches base roles too, through `requested.includes(r.baseRole)` in `roleRequestTargets`), append `" · operator wake in " + humanSeconds(Math.max(0, Math.round((d.scheduledWake.atMs - Date.now()) / 1000)))`. A row with an empty detail gets the phrase without the leading ` · `. Rows that do not match return exactly what they return today.
6. README: in the "Control the loops" row's `wake --in` sentence, add that `tumwater status` and the dashboard's loop rows show the pending wake until it fires.

Out of scope: the marker holds one wake, so a later `wake` request overwrites a pending scheduled one. That happens in the CLI too, and it is a separate behavior question. This plan shows whichever wake the marker holds, which is the one that will actually fire. Sibling: "Keep every pending scheduled wake…" (planned 2026-10-12) moves scheduled wakes into per-request files under `scheduledWakeDir` and adds `pendingScheduledWakes`. If it lands first, build step 1 on that reader (earliest entry), keeping a future-deadline `wake.json` as a fallback.

**Files touched.** `src/fleet/fleet-state.ts`, `src/status/status-data.ts`, `src/ui/status-payload.ts`, `src/ui/badges.ts`, `src/ui/status-render.ts`, `src/ui/gui/gui-client-loops.ts`, README.md. Tests go in `test/fleet-state.test.ts`, `test/badges.test.ts`, `test/status-payload.test.ts` (or `test/status-render.test.ts` for the header), and `test/gui-client-loops.test.ts`.

**Acceptance criteria.**
- `scheduledWake` tests: after `requestWake(root, ["feature"], 3_600_000)`, it returns `{ roles: ["feature"], atMs }` with `atMs` within the call's clock window. It returns undefined after an immediate `requestWake(root, ["feature"])`, for a marker whose `notBeforeMs <= now`, for a corrupt marker file, and with no marker at all. The marker file still exists after the read.
- `wakeBadge` tests: `wakeBadge({ roles: ["feature", "plan"], atMs: now + 45 * 60_000 }, now)` equals `" · wake scheduled in 45m (feature, plan)"`. It returns `""` for undefined and for `atMs <= now`.
- `statusPayload(root, now)` carries `scheduledWake` while a scheduled marker stands and has no `scheduledWake` key without one. The `renderStatus` header contains `wake scheduled in` only in the first case.
- `phaseDetail` tests in `test/gui-client-loops.test.ts`:
  - A sleeping row whose role is in `d.scheduledWake.roles` gets `"wakes in 2m · operator wake in 1h"` (the fixture pins `atMs` to `now + 3_600_000`).
  - A row whose `instanceOf` is listed also matches.
  - A row with an unlisted role, and any row when `d.scheduledWake` is absent, return exactly what the existing assertions expect.
- `npm run test` passes.

### Cancel a planned feature or open bug from the dashboard's entry drawer, matching `tumwater plan|bug --cancel <n>` (planned 2026-10-12 by plan; sibling of the landed CLI `tumwater plan --cancel` / `bug --cancel` (`cancelPlan`/`cancelBug` → `removeEntry` in `src/backlog/backlog-write.ts`) and the landed dashboard question-answer drawer form (`handleQuestionAnswer` over `tryAnswerQuestion` in `src/cli/question-commands.ts`). The dashboard can file a bug or plan (`POST /api/backlog-file`) but not retract one, so an operator who sees a wrong or obsolete entry in the drawer has to switch to the CLI and work out its position. Independent of the waiting pause-reason and scheduled-wake plans in behavior (its own route, handler, and drawer action), though it shares `src/gui/gui-server.ts`'s route table and `src/gui/gui-endpoint-commands.ts` with them, so a landing conflict is possible and the resolver handles it); done 2026-10-12 by feature

**Goal.** The entry drawer for a Planned feature or an Open bug offers a "Cancel this entry" button. It removes the entry exactly as `tumwater plan|bug --cancel <n>` does (same lock, same splice, no wake), guarded so the click cannot remove a different entry when the list has shifted since the poll.

**Approach.**
1. `src/backlog/backlog-write.ts`: split `locateEntry` into a non-exiting `findEntry(md, sectionTitle, n): ActionableEntryRange | undefined`. `locateEntry` keeps its `fail()` wording by calling it, so the CLI's output stays the same. Add an exported `tryCancelEntry(root, kind: "bug" | "plan", n, expectedTitle): CancelEntryOutcome`, where `CancelEntryOutcome = { status: "cancelled"; file; title } | { status: "gone" } | { status: "moved"; title }`. It runs under the same `withStateLock(primaryWorktreeLockPath(root), …)` that `removeEntry` takes, reads the file (absent → empty, like `readEntryLines`), and finds entry `n` in `"Open"`/`"Planned"`. Missing → `gone`. Title ≠ `expectedTitle` → `moved`, and nothing is written. Otherwise it applies the same splice and `writeTextAtomic` as `removeEntryLocked`. Share that splice through a small helper so it exists only once; do not copy it. `expectedTitle` is compared to `ActionableEntryRange.title`. The status payload's `plans`/`bugs` titles (`plannedPlans`/`openBugs` in `src/backlog/backlog.ts`) come from the same `### ` heading. A test pins that the two strings agree. If they differ (for example in trimming), normalize both sides in `tryCancelEntry`, not in the client.
2. `src/gui/gui-endpoint-commands.ts`: add `handleBacklogCancel` for `POST /api/backlog-cancel` with body `{"kind": "bug"|"plan", "position": <1-based>, "title": "<heading>"}`. Validation follows `handleQuestionAnswer`: `readPostBody`, then 400 on a bad kind (`handleBacklogFile`'s wording), a non-positive-integer position, or an empty title. `cancelled` → 200 `{ ok: true, status: "cancelled", file, title }`. `gone`/`moved` → 200 `{ ok: true, status: "gone" }` (the answer route's "already moved — refreshed" reading). Thrown errors → 400 `errorMessage(err)`. No wake and no inbox prompt: removing work must not wake a loop (`cancelAndAnnounce`'s rule). Register it in `src/gui/gui-server.ts`'s route table next to `"POST /api/backlog-file"`, and add it to the file's header list of routes.
3. `src/ui/gui/gui-client-drawer.ts` `refreshEntry`: for `file === "plans"` or `"bugs"`, add a `btn-danger` button `data-act='entry-cancel' data-arg='<file>:<index>'` after the "Ask the director" button. While armed it reads "Click again to cancel". Use a module-level `confirmEntryCancel = { key, until }` arm-then-fire with a 5 s window, the same shape as `confirmAbort` in `gui-client-loops.ts`: the first click arms and repaints, a second click inside the window fires, and a timeout disarms. Questions keep their answer form and get no cancel button.
4. `src/ui/gui/gui-client-boot.ts` `runAct`: add an `entry-cancel` branch, next to `answer-record`. Look up the title from `lastStatus[file][index]` (return when absent). If not armed, arm and return. If armed, `postAction("/api/backlog-cancel", { kind: file === "bugs" ? "bug" : "plan", position: index + 1, title }, …)`, then close the drawer. The flash reads `Cancelled “<title>” from PLANS.md` / `BUGS.md` on `cancelled`, or `That entry was already removed or moved — refreshed` otherwise.
5. Docs: README's "Steer the project" row gains "the dashboard's plan/bug drawer cancels an entry the same way". Update the `gui-client-drawer.ts` header comment's list of entry actions.

**Files touched.** `src/backlog/backlog-write.ts`, `src/gui/gui-endpoint-commands.ts`, `src/gui/gui-server.ts`, `src/ui/gui/gui-client-drawer.ts`, `src/ui/gui/gui-client-boot.ts`, README.md; tests in `test/backlog-write-cancel.test.ts`, `test/gui-operator.test.ts` (or wherever the HTTP `/api/question-answer` test lives; grep for it), `test/gui-client-drawer.test.ts`, `test/gui-client-boot.test.ts`.

**Acceptance criteria.**
- `tryCancelEntry` unit tests: removes the matching entry with the same bytes `cancelPlan`/`cancelBug` leave (compare against a `cancelBug` run on a copy); returns `gone` for an out-of-range position and for a missing file; returns `moved` and leaves the file byte-identical when the title at `n` differs; a title read through `plannedPlans`/`openBugs` matches for an entry carrying a `(planned … by …)` stamp. The existing `cancelBug` tests and the CLI's out-of-range `fail` wording still pass.
- HTTP tests over the real server: 200 `cancelled` removes the entry from the repo's PLANS.md/BUGS.md; a stale title → 200 `gone`, file unchanged; bad kind, position 0, missing title → 400; no inbox file is written under any outcome.
- Client tests: a plans/bugs entry drawer renders the `entry-cancel` button and a questions drawer does not; in `runAct`, the first `entry-cancel` posts nothing, a second inside the window posts `["/api/backlog-cancel", { kind: "plan", position: <index+1>, title }]`, and an index absent from `lastStatus` posts nothing.
- `npm run test` passes.

### Schedule one loop's wake from the dashboard's loop drawer, matching `tumwater wake <role> --in <duration>` (planned 2026-10-12 by plan; sibling of the landed fleet-wide "Wake later" menu (`WAKE_LATER_CHOICES`/`wakeLater` in `src/ui/gui/gui-client-loops.ts`'s `wake-later` region) and the landed per-loop timed pause (`pause-for` in `rowAction`, `ROLE_PAUSE_CHOICES`). `POST /api/wake` already takes `{ role, inSeconds }` and is tested that way (`test/gui-operator.test.ts`, "POST /api/wake with inSeconds schedules the wake like `tumwater wake --in`"). But the dashboard only sends `inSeconds` fleet-wide, so to say "run feature again in an hour" the operator has to use the CLI. Client-only change. It is independent of the waiting entry-drawer cancel plan: that plan touches `gui-client-drawer.ts`'s `refreshEntry` and `gui-client-boot.ts`, and this one touches the loop drawer and `rowAction`; done 2026-10-12 by feature)

**Goal.** A loop's drawer offers a "Wake later…" button. It opens an inline duration chooser, the same way "Pause for…" does. Choosing a duration posts `{ role, inSeconds }` to `/api/wake` and flashes the server's own confirmation (`requestWake`'s "wake scheduled for <role> — wakes in 1h — …").

**Approach.**
1. `src/ui/gui/gui-client-loops.ts`, `row-actions` region: replace the `rolePauseMenuRole`/`rolePauseMenuUntil` pair with one chooser state, `let roleChooser = null; // { role, action, until }`. Add `const roleChooserOpen = (role, action) => Boolean(roleChooser && roleChooser.role === role && roleChooser.action === action && roleChooser.until > Date.now());`. Keep `rolePauseMenuOpen = (role) => roleChooserOpen(role, "pause-for")` so existing callers and test stubs keep their name. Add `roleWakeMenuOpen = (role) => roleChooserOpen(role, "wake-in")`. Only one chooser is open at a time: opening a chooser replaces whatever chooser was open. Add `const ROLE_WAKE_CHOICES = ROLE_PAUSE_CHOICES.filter((c) => c[0] > 0);` (a wake has no "standing" choice).
2. `rowAction(action, role, forSeconds)`: generalize the `pause-for` early-return so it covers both `pause-for` and `wake-in`. With `forSeconds === undefined`, set `roleChooser = { role, action, until: Date.now() + 10000 }`, call `rerender()`, and return. The existing reset line (`rolePauseMenuRole = null`) becomes `roleChooser = null`. For `wake-in` with a seconds value, post to `/api/wake` with body `{ role, inSeconds: forSeconds }`. The flash is the server's `message`, or `role + " wakes in " + humanSeconds(forSeconds)` when the server sends none. The existing `wake` path is unchanged and still posts `{ role }`. Seconds travel in the existing `data-for` attribute, so the click handlers in `gui-client-loops.ts` (`#loops`) and `gui-client-drawer.ts` (the `button.rowaction` listener) need no change.
3. `src/ui/gui/gui-client-drawer.ts`, loop drawer actions: in the branch where `!info.live` and the drawer renders `btn("wake", "bolt", "Wake now")`, follow it with one of two things. If `roleWakeMenuOpen(l.role)`, render one `btn btn-sm rowaction` per `ROLE_WAKE_CHOICES` entry with `data-action='wake-in' data-for='<s>'` and label `"in " + c[1]`, in the same shape as the pause chooser. Otherwise render `btn("wake-in", "clock", "Wake later…")`. Paused loops get it too, because `requestWake` does not depend on pause state, just as "Wake now" does not. Live loops get neither: they show Abort instead of Wake. The table row is unchanged: its `clock` icon already means "Pause for a duration", and a second clock with no text label would be ambiguous. Update the drawer header comment's list of loop controls.
4. README "Control the loops" row: after the `wake --in 45m` sentence, add "the dashboard's loop drawer schedules one loop's wake the same way ("Wake later…")".

**Files touched.** `src/ui/gui/gui-client-loops.ts`, `src/ui/gui/gui-client-drawer.ts`, README.md; tests in `test/gui-client.test.ts` (the `rowAction` scope test), `test/gui-client-drawer.test.ts` (add a `roleWakeMenuOpen`/`ROLE_WAKE_CHOICES` stub next to `rolePauseMenuOpen`/`ROLE_PAUSE_CHOICES`), and `test/gui-client-loops.test.ts` if its stub list needs the new names.

**Acceptance criteria.**
- `rowAction` test: `rowAction("wake-in", "docs")` posts nothing. `rowAction("wake-in", "docs", 3600)` posts `{ path: "/api/wake", body: { role: "docs", inSeconds: 3600 } }` and flashes the server's message when one is given. The existing `wake`, `pause-for` (first click posts nothing; `3600` posts `forSeconds`; `0` posts a standing pause), and abort assertions still pass unchanged.
- Opening the wake chooser for a role closes that role's pause chooser, and the reverse also holds: after `rowAction("wake-in", "docs")`, `rolePauseMenuOpen("docs")` is false, and after `rowAction("pause-for", "docs")`, `roleWakeMenuOpen("docs")` is false. Firing either action closes both.
- Drawer test: an idle loop's drawer renders `data-action='wake-in'` with no `data-for=` while closed. With the chooser open, it renders one `data-action='wake-in' data-for='<s>'` button per `ROLE_WAKE_CHOICES` entry and none for `0`. A live loop's drawer renders no `wake-in`.
- The loops-table row renders no `wake-in` button (asserted in `test/gui-client-loops.test.ts`).
- `npm run test` passes.

### Schedule a fleet wake from the dashboard, matching `tumwater wake --in <duration>` (planned 2026-10-12 by plan; sibling of the landed CLI `tumwater wake --in` (`WAKE_IN_FLAG` in `src/cli/cli-flag-specs.ts` over `requestWake(root, roles, inMs)` in `src/operator/operator-intent.ts`) and the landed dashboard wake controls (`handleWake` over `POST /api/wake`, the Loops card's `#wakeall` button); `requestWake` already takes `inMs` and writes a `notBeforeMs` marker, but `handleWake` never passes one, so the operator who wants the fleet to start again after a break has to switch to the CLI; independent of the waiting question-answer part 2/2, reset-counters, and pause-reason plans in behavior (an optional body field on an existing route plus its own menu), though it shares `src/gui/gui-endpoint-commands.ts` with reset-counters and pause-reason and `src/ui/gui/gui-page.ts`'s Loops header with reset-counters, so a landing conflict is possible and the resolver handles it); done 2026-10-12 by feature

**Goal.** From the dashboard's Loops card, schedule a wake of every loop for later ("in 30 minutes"), writing the same deferred marker `tumwater wake --in 30m` writes.

**Approach.**
1. `src/gui/gui-endpoint-commands.ts`: add `wakeInSecondsMs(res, body): number | undefined | null`, the wake twin of `pauseForSecondsMs`. `body.inSeconds` undefined → `undefined`; not a finite number > 0 → 400 `inSeconds must be a positive number of seconds` plus `gotSuffix(inSeconds)`; `inSeconds * 1000 > PAUSE_FOR_MAX_MS` → 400 `inSeconds is capped at 7776000 seconds (90 days)` plus `gotSuffix` (the same cap `WAKE_IN_FLAG` applies through `failOverDurationCap`); otherwise return `Math.round(inSeconds * 1000)` — a duration, not a deadline, because `requestWake` takes `inMs` and reads its own clock. `handleWake` calls it after `readRoleBody`, returns on `null`, and passes the result as `requestWake`'s third argument; the response stays `{ ok: true, message }`, whose message is `requestWake`'s own "wake scheduled for … — wakes in …" text. Update `handleWake`'s doc comment to name the `inSeconds` field.
2. `src/ui/gui/gui-page.ts`: in the Loops card header, wrap a new `<button type="button" class="btn btn-sm" id="wakelater" aria-haspopup="menu" title="Wake every loop later">` (`clock` icon, label `Wake later`) in a `<div class="menu-anchor" id="wakelaterwrap">` beside `#wakeall` — the sidebar's `#pausewrap`/`#budgetwrap` use `menu-anchor up` to open upward; the header menu drops `up` so the popover opens downward under the plain `.menu-anchor` rule in `gui-styles.ts`. Since `openPopover` appends into the wrapper, render the button inside it in the page template and leave it there (no `paintPanel` repaint).
3. `src/ui/gui/gui-client-loops.ts`: add `WAKE_LATER_CHOICES = [[1800, "In 30 minutes"], [3600, "In 1 hour"], [7200, "In 2 hours"], [28800, "In 8 hours"]]`. Clicking `#wakelater` opens `openPopover("wakelaterwrap", { menu: true, role: "menu", html, onClosed })` with a `menu-title` "Wake every loop" and one `menu-item` button per choice carrying `data-wakein=<seconds>`; clicking one calls `closeMenus()` and `postAction("/api/wake", { inSeconds }, (d) => d && typeof d.message === "string" ? d.message : "wake scheduled in " + humanSeconds(inSeconds))`. Keep the code in its own `// wake-later:start` / `// wake-later:end` section marker so the client test can scope to it. (`openPopover`/`closeMenus` are in the same concatenated client script — `gui-client-operator.ts` and `gui-client.ts` — confirm the section order puts `openPopover` in scope at click time, as `openPauseMenu` does.)

**Files touched.** `src/gui/gui-endpoint-commands.ts`, `src/ui/gui/gui-page.ts`, `src/ui/gui/gui-client-loops.ts`, `test/gui-operator.test.ts`, `test/gui-client.test.ts`; `docs/invariants.md` only if its GUI section enumerates `/api/wake`'s body fields.

**Acceptance criteria.**
- `test/gui-operator.test.ts` (extend "POST /api/wake writes the same state as `tumwater wake` and rejects bad bodies" or add a sibling test): `{"inSeconds": 1800}` answers 200 with a message matching `/wakes in 30m/` (`durationLabel(1800000)` renders `30m`) and writes a wake marker whose `notBeforeMs - at` is 1800000 and whose roles are every configured role; `{"role": "feature", "inSeconds": 60}` scopes it to feature; `inSeconds` of `0`, `-5`, `"30"`, and `7776001` each answer 400 and leave no marker.
- `test/gui-client.test.ts`: clicking `#wakelater` renders four `[data-wakein]` items; clicking the 1-hour item posts `{ path: "/api/wake", body: { inSeconds: 3600 } }` and closes the menu.
- `#wakeall` keeps posting `{}` (the existing wake client test stays green unchanged).
- `npm run test` passes.

### Give a fleet pause a reason from the dashboard, matching `tumwater pause --reason <text>` (planned 2026-10-12 by plan; sibling of the landed CLI `tumwater pause --reason` (`cmdPause` in `src/operator/operator-commands.ts` over `pauseFleet(root, untilMs, reason)` in `src/fleet/fleet-state.ts`) and the landed dashboard pause menu (`openPauseMenu`/`setFleetPause` in `src/ui/gui/gui-client-operator.ts` over `handlePause` / `POST /api/pause`); `PAUSE_REASON_MAX`'s doc comment already anticipates "any later GUI path", and the dashboard already *shows* a reason (the payload's `pauseReason` reaches `fleetAlerts` in `src/ui/fleet-alerts.ts`), but its pause menu cannot write one, so an operator who pauses from the browser leaves the fleet's other watchers no note; independent of the waiting question-answer part 2/2, disk-row reclaim, and reset-counters plans in behavior (its own body field on an existing route), though it shares `src/gui/gui-endpoint-commands.ts` with reclaim and reset-counters, so a landing conflict is possible and the resolver handles it) (done 2026-10-12 by feature)

**Goal.** The dashboard's sidebar pause menu takes an optional one-line reason that rides whichever pause choice the operator clicks, and the server writes it into the fleet marker exactly as `tumwater pause --reason` does.

**Approach.**
- `src/gui/gui-endpoint-commands.ts`, `handlePause`: accept an optional `reason` in the body, validated by a new local helper `pauseReasonField(res, body, pausing)` that sits beside `pauseForSecondsMs` and follows its shape (returns `string | undefined`, or `null` once it has sent a 400):
  - absent → `undefined`;
  - present with `paused: false` → 400 `"reason only applies when pausing (paused: true)"` (same wording as the `forSeconds` rule);
  - not a string → 400 `"reason must be a string"` plus `gotSuffix(reason)`;
  - a string that is empty or whitespace-only → `undefined`, so a blank input sends a plain pause. The client already omits blank reasons, and treating them as absent keeps a retried or hand-written request harmless.
  - No length check here. `pauseFleet` folds the text and caps it at `PAUSE_REASON_MAX` through `normalizePauseReason`, the one shared home, so the CLI and the GUI cannot drift.
  - Then call `pauseFleet(root, untilMs, reason)`. The 200 body adds `reason: normalizePauseReason(reason)` only when that is non-empty, so the client can echo what was stored. Update `handlePause`'s doc comment to name the field.
- `src/ui/gui/gui-client-operator.ts`, pause-control section:
  - `openPauseMenu` adds a single-line `<input id='pausereason' maxlength=… placeholder='Reason (optional)'>` between the title and the choices. Interpolate `maxlength` as `${PAUSE_REASON_MAX}`, imported from `src/fleet/fleet-state.ts` into the `String.raw` template. This follows the precedent of `gui-client-model.ts` interpolating `STALL_SOURCE` at module build.
  - Focus stays on the first menu item as today.
  - `setFleetPause(paused, forSeconds, reason)` adds `body.reason = reason.trim()` only when pausing and the trimmed text is non-empty.
  - The `[data-pause]` click handler reads `$("pausereason")?.value`.
  - Enter in the input does nothing special. The operator still picks a duration.
  - `pauseControlHtml`'s Resume button appends the reason to its `title` (escaped) when `d.pauseReason` is set.
  - Update the module doc comment's pause-control sentence.
- No change to `fleet-state.ts`, the status payload, or `fleet-alerts.ts`: the reason is already read back from the marker and rendered there.

**Files touched.** `src/gui/gui-endpoint-commands.ts`, `src/ui/gui/gui-client-operator.ts`, `test/gui-operator.test.ts`, `test/gui-client.test.ts`; `docs/invariants.md` only if its dashboard/operator section pins `/api/pause`'s body (check with `grep -n "api/pause" docs/invariants.md`); README's "Control the loops" row only if it describes the dashboard pause menu.

**Acceptance criteria.**
- `test/gui-operator.test.ts` covers these cases, using that file's existing `postJson`/`postRaw` helpers and `pausedPath`:
  - `POST /api/pause {"paused": true, "reason": "  deploying\n v2 "}` → 200 with `reason: "deploying v2"`, and the marker's `reason` is `"deploying v2"`;
  - `{"paused": true, "forSeconds": 3600, "reason": "x"}` writes both `until` and `reason`;
  - `{"paused": true, "reason": "   "}` writes no `reason`;
  - `{"paused": false, "reason": "x"}` → 400 matching `/only applies when pausing/`;
  - `{"paused": true, "reason": 5}` → 400 matching `/must be a string/`;
  - a 300-char reason is stored at most `PAUSE_REASON_MAX` chars long.
- `test/gui-client.test.ts`'s pause-control scope test:
  - `setFleetPause(true, 3600, " why ")` posts `{ paused: true, forSeconds: 3600, reason: "why" }`;
  - `setFleetPause(true, 0, "  ")` posts `{ paused: true }`;
  - the existing calls without a reason still post the exact bodies they pin today;
  - `pauseControlHtml({ paused: true, pauseReason: "deploy" })` contains `deploy` in the Resume button's title.
- A pause without `reason` behaves as before: the existing `/api/pause` tests pass unchanged.
- `npm run test` passes.

### Reset the loops' counters from the dashboard, matching `tumwater reset-counters [--role <id>]` (planned 2026-10-12 by plan; sibling of the landed CLI `tumwater reset-counters` (`cmdResetCounters` in `src/operator/operator-commands.ts` over `requestResetCounters` in `src/operator/operator-intent.ts`) and the landed dashboard wake controls (`handleWake` over `POST /api/wake`, the Loops card's `wakeall` button, the loop drawer's `wake` action); `requestResetCounters` already never calls `fail()`, and its doc comment says no dashboard route exposes it, so the operator who wants a fresh observation window in the dashboard has to switch to the CLI; independent of the waiting question-answer part 2/2, Claude usage-meter, and disk-row reclaim plans in behavior (its own route, handler, and action), though it shares `src/gui/gui-server.ts`/`gui-endpoint-commands.ts` with the reclaim plan and `gui-client-drawer.ts` with part 2/2, so a landing conflict is possible and the resolver handles it); done 2026-10-12 by feature

**Goal.** The dashboard zeroes the per-loop counters (ticks, commits, tokens, cost) the same way the CLI does: fleet-wide from the Loops card header, or for one loop from its drawer, and flashes the CLI's own confirmation.

**Approach.**
- `src/gui/gui-endpoint-commands.ts`: add `handleResetCounters`, shaped exactly like `handleWake`: `readRoleBody(req, res, '{"role": "feature"}', root, true)`, then 200 `{ ok: true, message: requestResetCounters(root, body.role === undefined ? validRoleIds(root) : [body.role as string]) }`. Add it to `readRoleBody`'s doc comment list of call sites. Register `"POST /api/reset-counters"` in `src/gui/gui-server.ts`'s route table beside `"POST /api/wake"`.
- `src/operator/operator-intent.ts`: reword `requestResetCounters`'s doc comment so it says the CLI and `POST /api/reset-counters` share the core (drop "no dashboard route exposes reset-counters"). No behavior change.
- `src/ui/gui/gui-page.ts`: in the Loops card header, add `<button type="button" class="btn btn-sm" id="resetall" title="Zero every loop's ticks, commits, tokens, and cost — scheduling is untouched">${iconSvg("refresh")}<span>Reset counters</span></button>` before `wakeall`.
- `src/ui/gui/gui-client-loops.ts`: beside the `wakeall` listener, `$("resetall")` posts `postAction("/api/reset-counters", {}, (d) => d && typeof d.message === "string" ? d.message : "counters reset")`. In `rowAction`, route `action === "reset-counters"` to `/api/reset-counters` with body `{ role }` (extend the existing `path` expression; the existing `d.message` fallback covers its flash). No confirm step: the CLI has none and the reset touches observation counters only, never scheduling.
- `src/ui/gui/gui-client-drawer.ts`: the loop drawer's actions gain `btn("reset-counters", "refresh", "Reset counters")` after the pause controls. It uses the existing `rowaction` class, so the drawer's click handler already routes it to `rowAction`.
- `docs/how-it-works.md`'s `reset-counters` bullet and README.md's "Control the loops" row: note that the dashboard's Loops card and loop drawer reach the same reset.
- docs/invariants.md: no new guarantee. The marker and its consumption (`consumeResetRequest`) are unchanged.

**Files touched.** `src/gui/gui-endpoint-commands.ts`, `src/gui/gui-server.ts`, `src/operator/operator-intent.ts`, `src/ui/gui/gui-page.ts`, `src/ui/gui/gui-client-loops.ts`, `src/ui/gui/gui-client-drawer.ts`, `test/gui-operator.test.ts`, `test/gui-client.test.ts`, `test/gui-client-drawer.test.ts`, `docs/how-it-works.md`, `README.md`.

**Acceptance criteria.**
- `test/gui-operator.test.ts`, beside `POST /api/wake writes the same state as \`tumwater wake\``: with no harness running, `POST /api/reset-counters` `{ role: "feature" }` answers 200 with the same message `requestResetCounters(repo, ["feature"])`'s CLI path prints, and the feature loop's saved state has its counters zeroed (seed a nonzero tick count with `saveLoopState` first). `{}` targets every configured role. `{"role": "bogus"}` answers 400 matching `/valid ids:/` and a malformed body answers 400, each leaving the seeded counters untouched.
- `test/gui-client.test.ts`'s loop-controls test: `rowAction("reset-counters", "feature")` posts exactly `{ path: "/api/reset-counters", body: { role: "feature" } }` and flashes the server's message.
- `test/gui-client-drawer.test.ts`: the painted loop drawer contains `data-action='reset-counters'`.
- `npm run test` is green.

### Reclaim build outputs from the dashboard's disk row, matching `tumwater reclaim` (planned 2026-10-12 by plan; sibling of the landed CLI `tumwater reclaim` (`cmdReclaim` in `src/operator/operator-commands.ts`) and the landed sidebar stale-build restart button (`restartButton` in `src/ui/gui/gui-client-fleet.ts`, `runAct`'s `restart` branch in `gui-client-boot.ts`, `handleRestart` over `POST /api/restart`); the sidebar's disk row says the fleet is holding work or that free space is below the reclaim threshold, but offers no way to act on it, so the operator has to switch to the CLI; independent of the waiting question-answer parts 1/2 and 2/2, backlog-file, and Claude usage-meter plans in behavior (its own route, handler, and `data-act`), though it shares `src/gui/gui-server.ts`/`gui-endpoint-commands.ts`/`gui-client-boot.ts` with them, so a landing conflict is possible and the resolver handles it); done 2026-10-12 by feature

**Goal.** When the sidebar's disk row is amber (held) or reports the reclaim band, its leading icon is a button. Clicking it runs the same manual reclaim `tumwater reclaim` runs, and flashes the same confirmation the CLI prints.

**Approach.**
- `src/operator/operator-intent.ts`: add an exported `async function runManualReclaim(root: string): Promise<string>` holding `cmdReclaim`'s non-dry-run branch, unchanged in behavior: when `markerApplyNote(root).live`, return `requestReclaim(root)`. Otherwise await `reclaimPass(root, "manual", { reclaimGB: 0 })` (from `src/fleet/reclaim.ts`) and return `"nothing to reclaim"` for a null result or `` `reclaimed ${result.worktrees.join(", ")} — freed ${formatGB(result.freedGB)}` `` (`formatGB` from `src/text/format.ts`). It never calls `fail()`, so a server can call it. `cmdReclaim` keeps its `--dry-run` branch and replaces the rest with `say(await runManualReclaim(root))`. Drop any import from `operator-commands.ts` that this leaves unused (`reclaimPass`, `formatGB`, `requestReclaim`, `markerApplyNote` — check each with grep first).
- `src/gui/gui-endpoint-commands.ts`: add `handleReclaim`, shaped like `handleRestart`. It reads the body with `readPostBody(req, res, "{}")`, ignores the body, and answers 200 `{ ok: true, message: await runManualReclaim(root) }`. A throw reaches the server's outer catch as a 500, like the other handlers. Register `"POST /api/reclaim"` in `gui-server.ts`'s route table beside `"POST /api/restart"`.
- `src/ui/gui/gui-client-fleet.ts`: add `reclaimButton(glyph)` beside `restartButton`, returning `<button type='button' class='alert-icon' data-act='reclaim' title='Reclaim idle build outputs now'>` + glyph + `</button>`. In `renderSidebar`'s disk row (the `if (d.diskBadge)` block), the lead is `reclaimButton(icon("info"))` when `held || low`, and plain `icon("info")` otherwise. The row's text and tones stay as they are.
- `src/ui/gui/gui-client-boot.ts`: `runAct` gains `else if (act === "reclaim") postAction("/api/reclaim", {}, (d) => d && typeof d.message === "string" ? d.message : "Reclaim requested")`, the same shape as the `restart` branch.
- docs/invariants.md: no new guarantee. The reclaim pass and its marker protocol are unchanged.

**Files touched.** `src/operator/operator-intent.ts`, `src/operator/operator-commands.ts`, `src/gui/gui-endpoint-commands.ts`, `src/gui/gui-server.ts`, `src/ui/gui/gui-client-fleet.ts`, `src/ui/gui/gui-client-boot.ts`, `test/gui-endpoints.test.ts`, `test/gui-client-sidebar.test.ts`, and README.md's dashboard mention only if it lists sidebar controls.

**Acceptance criteria.**
- The existing `cmdReclaim` tests in `test/operator-commands.test.ts` (live marker, nothing-to-reclaim in both modes, `--dry-run` listing) stay green unchanged.
- `test/gui-endpoints.test.ts`: `handleReclaim` against a temp repo with no worktrees answers 200 `{ ok: true, message: "nothing to reclaim" }`. With a live fleet marked (as the `cmdReclaim` live test does), it answers 200 with a message matching `/reclaim requested/`, and `reclaimRequestPath(root)` exists. A malformed body answers 400 and writes no marker.
- `test/gui-client-sidebar.test.ts`: the disk row's painted HTML contains `data-act='reclaim'` for a held disk and for one below `reclaimGB`. It does not contain `data-act='reclaim'` when the disk is above `reclaimGB` and not held (the recovered "last reclaim freed" case).
- `npm run test` is green.

### Answer an open question from the dashboard, part 2/2: an inline answer form in the Questions tab and entry drawer (done 2026-10-12 by feature; planned 2026-10-12 by plan; requires part 1/2's `POST /api/question-answer` landed; sibling of the landed dashboard queued-prompt edit (`gui-client-fleet.ts`'s Queued-tab Edit over `/api/prompt-edit`) and the CLI `tumwater questions answer`; independent of the waiting TUI Activity filter and dashboard per-loop timed pause plans in behavior — `src/ui/gui` only — though it may share `gui-client-drawer.ts` with the timed-pause plan's drawer button, so a landing conflict is possible and the resolver handles it)

**Goal.** Make the dashboard's Answer control record the decision in QUESTIONS.md, as `tumwater questions answer` does. Keep drafting a director prompt available as a secondary action, for when the operator wants the director to act on the answer.

**Approach.**
1. `src/ui/gui/gui-client-drawer.ts`: in `refreshEntry`, when `file === "questions"`, render an inline form in the `drawer-actions` area in place of the single "Answer in the composer" button: a `<textarea id='answertext'>`, a primary `Record answer` button (`data-act='answer-record' data-arg='<index>'`), and the existing composer draft renamed "Ask the director instead" (`data-act='answer'`, behavior unchanged). Do not re-paint the textarea once the operator has typed in it. Follow whatever the Queued-tab edit form already does for the same problem (`paintPanel` skips identical HTML); if the poll would repaint `entrybody`, keep the draft across repaints the way that form does.
2. `src/ui/gui/gui-client-boot.ts`: add an `answer-record` branch to `runAct`. It reads `lastStatus.questions[Number(arg)]` (the full heading text `openQuestions` returns, which is the title part 1/2 compares) and the trimmed `#answertext` value. With an empty value it flashes `Write an answer first` and posts nothing. Otherwise it calls `postAction("/api/question-answer", { position: Number(arg) + 1, title, decision }, (d) => …)`, flashing `Answered “<title>” — moved to ## Answered` for `answered` and `That question was already answered or moved — refreshed` for `gone`, and then closes the drawer.
3. `src/ui/gui/gui-client-fleet.ts`: the Questions tab row's `Answer` button (`data-act='answer'`) now opens the entry drawer for that question: render it as a second `backloglink` button carrying `data-file='questions' data-index='<i>'`, the attributes the row title's `li-open` button already uses to reach `openEntry`/`toggleEntry`, instead of `data-act='answer'`, so the form from step 1 is the one place an answer is written.
4. `docs/how-it-works.md` (dashboard notes) and the README "Answer open questions" row: add that the dashboard's question drawer records an answer the same way.

**Files touched.** `src/ui/gui/gui-client-drawer.ts`, `src/ui/gui/gui-client-boot.ts`, `src/ui/gui/gui-client-fleet.ts`, `test/gui-client-drawer.test.ts`, `test/gui-client-boot.test.ts`, `test/gui-client-fleet.test.ts`, `docs/how-it-works.md`, `README.md`.

**Acceptance criteria.**
- `test/gui-client-drawer.test.ts`: a question entry's painted `entrybody` contains `id='answertext'`, `data-act='answer-record' data-arg='<index>'`, and the retained `data-act='answer'`. Update the existing `data-act='answer' data-arg='2'` assertion rather than delete it. Plan and bug entries still render only "Ask the director about this".
- `test/gui-client-boot.test.ts`: `answer-record` with text posts exactly `{ position: index + 1, title: <status title>, decision: <trimmed text> }` to `/api/question-answer`, and with an empty textarea posts nothing and flashes the hint.
- `test/gui-client-fleet.test.ts`: the Questions-tab Answer button carries `data-file='questions' data-index='<i>'` rather than `data-act='answer'`.
- `npm run test` is green.


### Show the Claude window's usage as a meter in the dashboard, and say when usage is unreported (planned 2026-10-12 by director from a user request; the TUI header already prints `Claude 5h · 64%` through `claudeWindowBadge` in `src/ui/badges.ts` whenever `utilization` is reported, so this is a `src/ui/gui` change only) — done 2026-10-12

**Why.** The dashboard's `windowLine` in `src/ui/gui/gui-client-operator.ts` already prints the percentage when the window carries `utilization` (0–1) and falls back to the status word `ok` otherwise. The claude CLI's `rate_limit_event` (parsed in `src/agent/claude/claude-stream.ts`) reports `utilization` only intermittently, so most of the time the card reads "ok" and the operator cannot tell that the number is simply unreported. No other data source exists without a network call, which the zero-dependency principle and the offline-test rule rule out; do not synthesize a percentage from elapsed time.

**Goal.** Fill a progress bar from `utilization` when it is reported, and make the unreported case read as unreported rather than as a health verdict.

**Approach.** In `src/ui/gui/gui-client-operator.ts`:
1. `windowLinesHtml` renders, for each window with a numeric `utilization`, the existing `window-line` span followed by `<span class='meter<tone>'><span style='width:N%'></span></span>` (N = `Math.min(100, Math.round(utilization * 100))`; tone from the existing `windowLineTone`: `t-red`/`t-amber`), reusing the `.meter` styles the spend card uses; the percentage text stays in the line.
2. When `utilization` is not a number, `windowLine` uses `ok · usage not reported` in place of the bare `ok` (the `near limit`/`limited`/`reset` words stay as they are), and no meter is drawn.
3. Pin both in a test beside the existing `windowLine`/budget-card tests in `test/gui-client.test.ts` (add `windowLinesHtml` to its scope list if needed): a reported 0.64 renders `64%` and a `width:64%` meter, 1.2 clamps to `width:100%`, an unreported `allowed` window renders `usage not reported` and no `meter`.
4. `plans/agent-backends.md` §8's table row and `docs/how-it-works.md` (if it names the window card) note the meter and the unreported wording.

**Files touched.** `src/ui/gui/gui-client-operator.ts`, `test/gui-client.test.ts`, `plans/agent-backends.md`, possibly `docs/how-it-works.md`. The `.meter` CSS is reused unchanged.

**Acceptance criteria.**
- A window with `utilization: 0.64` shows `Claude 5h · 64% · resets HH:MM` and a meter 64% wide, amber/red per status.
- A window without `utilization` shows `Claude 5h · ok · usage not reported · resets HH:MM` and no meter.
- The TUI header string from `claudeWindowBadge` is unchanged.
- `npm run test` is green.

### File a bug or request a plan from the dashboard, matching `tumwater bug "<symptom>"` and `tumwater plan "<title>"` (planned 2026-10-12 by plan; sibling of the landed CLI `tumwater bug`/`tumwater plan` (`fileBug`/`filePlan` and `fileAndAnnounce` in `src/backlog/backlog-write.ts`, dispatched from `src/cli.ts`'s `bug`/`plan` cases) and the landed dashboard Queued-tab in-place edit (`gui-client-fleet.ts`'s `queuedEdit`/`queuedEditPainted`); the dashboard's Plans and Bugs tabs list entries but cannot add one, so the operator has to switch to the CLI or ask the director to file them; independent of the waiting dashboard per-loop timed pause and question-answer parts 1/2 and 2/2 in behavior (its own route, handler, and tab-form state), though it shares `src/gui/gui-server.ts`/`gui-endpoint-commands.ts` with them, so a landing conflict is possible and the resolver handles it); done 2026-10-12 by feature

**Goal.** A Plans- or Bugs-tab "New" control opens a single-line form. Saving it writes the same `### <title> (reported by the operator <date>)` entry the CLI writes, and wakes the same loop with the same prompt (bug → `bugfix`, plan → `feature`).

**Approach.**
- `src/backlog/backlog-write.ts`: hoist the two inline wake-text lambdas from `src/cli.ts`'s `bug`/`plan` cases into exported `bugWakeText(title)` / `planWakeText(title)`, keeping their wording unchanged. Add an exported `OPERATOR_FILE_KINDS` record `{ bug: { role: "bugfix", wakeText: bugWakeText }, plan: { role: "feature", wakeText: planWakeText } }`. `src/cli.ts` passes these to `fileAndAnnounce` in place of its lambdas, so the CLI and the dashboard have one source for the wording.
- `src/gui/gui-endpoint-commands.ts`: add `handleBacklogFile`, which handles `POST /api/backlog-file` with body `{"kind": "bug"|"plan", "title": "..."}`. It reads the body with `readPostBody`. It answers 400 when `kind` is not one of the two keys or when `collapseWhitespace(title)` is empty. The empty check runs here, before `fileBug`/`filePlan` is called, because their own empty check goes through `fail()` (cli-output.ts), which exits the process. It also answers 400 with the message when `promptLengthProblem(wakeText(title), role)` is non-null. Both checks run before anything is written, the same order `fileAndAnnounce` uses. Then it calls `fileBug(root, title, usage)` or `filePlan(root, title, "", usage)`, then `submitRolePromptAndWake(root, role, wakeText(filed.title))`, and answers 200 `{ ok: true, file, title }`. An unexpected throw (EACCES) still reaches the server's outer catch as a 500. Register the route `"POST /api/backlog-file"` in `gui-server.ts`'s route table.
- `src/ui/gui/gui-client-fleet.ts`: when `backlogTab` is `plans` or `bugs`, `renderBacklog` paints a leading `<button ... data-action='backlognew'>` ("New plan" / "File a bug") above the list or the empty state. Clicking it sets new state `backlogNew = { kind }`, painted as an `<input id='backlognew'>` with `backlognewsave`/`backlognewcancel` buttons. It reuses `queuedEditPainted`'s guard so the 1 s poll does not repaint over the operator's typing, and `setBacklogTab` clears it the same way it clears `queuedEdit`. Save posts through `postAction("/api/backlog-file", { kind, title })` and flashes `"Filed: " + d.title`. An empty input does nothing.
- docs/invariants.md: no new guarantee section; the entry format is still the one `appendOperatorEntry` owns.

**Files touched.** `src/backlog/backlog-write.ts`, `src/cli.ts`, `src/gui/gui-endpoint-commands.ts`, `src/gui/gui-server.ts`, `src/ui/gui/gui-client-fleet.ts`, `test/gui-endpoints.test.ts`, `test/gui-client-fleet.test.ts`, plus README.md's dashboard mention if one lists the tab controls.

**Acceptance criteria.**
- `test/gui-endpoints.test.ts`: against a temp repo, `handleBacklogFile` with `{kind:"bug", title:"  x  y "}` answers 200 `{ ok: true, file: "BUGS.md", title: "x y" }`, BUGS.md `## Open` gains `### x y (reported by the operator <today>)`, and a `bugfix` prompt is queued whose text equals `bugWakeText("x y")`. With `kind:"plan"`, the entry lands under PLANS.md `## Planned` and the prompt is queued for `feature`. Each of these answers 400 and leaves both files and both queues untouched: `kind:"todo"`, `title:"   "`, a missing title, and a title long enough that `promptLengthProblem` objects.
- The existing CLI `bug`/`plan` tests stay green with no change to their expected wake text.
- `test/gui-client-fleet.test.ts`: on the Plans and Bugs tabs the painted HTML contains `data-action='backlognew'`, and the Questions and Queued tabs do not. After the New click, the input and the Save/Cancel pair are painted, a re-render from a poll keeps them, and switching tabs drops them.
- `npm run test` is green.

### Pause a loop for a duration from the dashboard, matching `tumwater pause --role <id> --for <duration>` (planned 2026-10-12 by plan; sibling of the landed dashboard fleet pause menu (`gui-client-operator.ts`'s `PAUSE_CHOICES`/`openPopover` and `/api/pause`'s `forSeconds`) and the landed CLI per-role timed pause (`cmdPause` in `src/operator/operator-commands.ts` parsing `--for` into `pauseRole(root, role, untilMs)`); the dashboard's `POST /api/pause-role` (`handlePauseRole` in `src/gui/gui-endpoint-commands.ts`) reads only `paused` and calls `pauseRole(root, role)` with no deadline, and the per-row pause button is a bare toggle (`gui-client-loops.ts`'s `rowAction`), so scheduling an auto-resume for one loop means dropping to the CLI; independent of the waiting TUI Queued-pane edit and TUI Activity filter plans in files — `src/gui` and `src/ui/gui` only, plus `src/fleet/fleet-state.ts`/`src/status/status-data.ts` for the shared deadline read, no `src/ui/tui` file; it writes through the same `pauseRole` the CLI and TUI Ctrl+P use, so the marker format and its one shared `until` cannot drift) — done 2026-10-12 by feature

**Goal.** Let an operator choose a duration when pausing one loop from the dashboard — the same 30m/1h/2h/8h/standing choices the fleet pause menu offers — and see the auto-resume countdown on the paused row and drawer, matching `tumwater pause --role <id> --for <duration>`.

**Approach.**
1. `src/gui/gui-endpoint-commands.ts`: extract the `forSeconds` validation already inline in `handlePause` into `pauseForSecondsMs(res, body, pausing): number | undefined | null` (returns `undefined` when absent, the rounded millisecond span when valid, and `null` after sending the same 400s: `forSeconds only applies when pausing (paused: true)`, `must be a positive number of seconds`, and the `PAUSE_FOR_MAX_MS` (90-day) cap line). Call it from `handlePause` unchanged in behavior, and from `handlePauseRole`: compute `untilMs` and call `pauseRole(root, body.role as string, untilMs)` (the writer already accepts it), keeping `resumeRole`'s path deadline-free; include `until: untilMs` in the response only when timed.
2. `src/fleet/fleet-state.ts`: factor the marker read out of `pausedRoles` into a private `readPausedRoles(path): { roles: string[]; until?: number }` (applying the same finite, non-expired `until` rule) and add `export function pausedRolesUntil(root): number | undefined` returning the future shared deadline only while the set is non-empty. `pausedRoles` and `pausedRolesUntil` then share one read, so the set and the deadline cannot disagree.
3. `src/status/status-data.ts`: import `pausedRolesUntil` and add `pausedRolesUntil?: number` to `StatusData` beside `pausedUntil`; set it in the snapshot. Document it as the paused-roles marker's one shared `until` (the field `--for` writes), absent for a standing role pause, a fleet-only pause, or after expiry.
4. `src/ui/gui/gui-client-loops.ts`:
   - `phaseDetail` appends the countdown: when `info.key === "paused"` and `d.pausedRolesUntil`, return `info.detail + " · resumes in " + humanSeconds(Math.max(0, Math.round((d.pausedRolesUntil - Date.now()) / 1000)))`.
   - In the `row-actions` region add `let pauseMenuRole = null`, `let pauseMenuUntil = 0`, and `const pauseMenuOpen = (role) => pauseMenuRole === role && pauseMenuUntil > Date.now()` (mirroring `confirmAbort`/`abortConfirming`), plus `const ROLE_PAUSE_CHOICES = [[1800, "30m"], [3600, "1h"], [7200, "2h"], [28800, "8h"], [0, "standing"]]`.
   - In `loopCells`'s unpaused arm add a second control beside the existing `pause` toggle: `b("pause-for", "clock", "Pause " + l.role + " for a duration")`; when `pauseMenuOpen(l.role)`, render `ROLE_PAUSE_CHOICES` as `data-action='pause-for' data-for='<seconds>'` buttons instead. (The standing `pause`/`resume` buttons and the one-click standing pause stay exactly as they are.)
   - Extend the `#loops` click handler to pass `Number(b.dataset.for)` as a third argument; `rowAction(action, role, forSeconds)` handles `pause-for` by arming the menu when `forSeconds` is `undefined` (`pauseMenuRole = role; pauseMenuUntil = Date.now() + 10_000; rerender()`) and otherwise posting `{ role, paused: true, ...(forSeconds > 0 ? { forSeconds } : {}) }` to `/api/pause-role`, clearing the menu, and toasting `"<role> paused for " + humanSeconds(forSeconds)` or the existing standing wording.
5. `src/ui/gui/gui-client-drawer.ts`: add the same `btn("pause-for", "clock", "Pause for…")` control and chooser to `renderLoopDrawer`'s actions (the countdown arrives via the shared `phaseDetail`).
6. `test/gui-client-loops.test.ts` and `test/gui-client-drawer.test.ts`: add `pauseMenuOpen` to the `clientScope`/`drawerScope` stand-ins (like `abortConfirming`) and pin the chooser's rendered buttons and the countdown line; `test/gui-client.test.ts`'s row-action scope gains `"format"` in its region list and a `pause-for` case asserting the posted body and toast.
7. `docs/how-it-works.md`: the dashboard/operator notes name the per-loop timed pause (the same choices as the fleet pause menu) and its auto-resume countdown, matching `tumwater pause --role <id> --for`.

**Files touched.** `src/gui/gui-endpoint-commands.ts`, `src/fleet/fleet-state.ts`, `src/status/status-data.ts`, `src/ui/gui/gui-client-loops.ts`, `src/ui/gui/gui-client-drawer.ts`, `test/gui-operator.test.ts`, `test/status-data-fleet.test.ts`, `test/gui-client.test.ts`, `test/gui-client-loops.test.ts`, `test/gui-client-drawer.test.ts`, `docs/how-it-works.md`.

**Acceptance criteria.**
- `POST /api/pause-role {role, paused:true, forSeconds:3600}` writes the same `{roles, at, until}` marker `tumwater pause --role <id> --for 1h` writes through `pauseRole`, responds with `until` within a second of `Date.now() + 3_600_000`, and a later request with a different `forSeconds` overwrites that shared `until`; `forSeconds` on `paused:false`, and a zero/negative/non-finite/over-cap value, each get the same 400 wording `/api/pause` uses and write no marker.
- `status --json`/`/api/status` carry `pausedRolesUntil` while a timed per-role pause stands and omit it after expiry, on resume, and on a standing role pause; whenever the field is present the `pausedRoles` set is non-empty (`pausedRolesUntil > Date.now()`).
- The dashboard's per-loop control offers the duration choices; choosing one shows `Paused — starts no new ticks · resumes in …` on the row and drawer, counting down each poll; the existing one-click standing pause and resume still post `{role, paused:true|false}` with no `forSeconds`.
- `npm run test` is green.

### Answer an open question from the dashboard, part 1/2: a non-exiting answer core and `POST /api/question-answer` (done 2026-10-12 by feature; planned 2026-10-12 by plan; sibling of the landed CLI `tumwater questions answer <n> <decision>` (`answerQuestion` in `src/cli/question-commands.ts`) and part 2/2 below, which adds the browser affordance over this endpoint; the dashboard's only answer control (`gui-client-boot.ts`'s `runAct` `answer` branch, reached from the Questions tab's Answer button and the entry drawer's "Answer in the composer") drafts a director prompt, so the question stays under `## Open` until a loop or the CLI moves it; independent of the waiting TUI Activity filter and dashboard per-loop timed pause plans in files — `src/cli/question-commands.ts` and `src/gui` only, no `src/ui` file; it shares `src/gui/gui-endpoint-commands.ts`/`gui-server.ts` with the timed-pause plan but adds a new handler rather than editing `handlePauseRole`, so a landing conflict is possible and the resolver handles it)

**Goal.** Let the dashboard server record an operator's answer to the Nth open question exactly as `tumwater questions answer <n> <decision>` does — same file surgery, same primary-worktree lock — without the process exit the CLI path uses for errors.

**Why a new core.** `answerQuestionLocked` reports a bad position and an unclosed fence in `## Open` through `fail()` (`src/cli/cli-output.ts`), which calls `process.exit(1)`. The dashboard handler runs inside `tumwater gui` / `tumwater run --gui`, so calling `answerQuestion` from it would let a stale click end the fleet. The endpoint needs a core that returns its refusals as data.

**Approach.**
1. `src/cli/question-commands.ts`:
   - Rename `answerQuestionLocked`'s body into an exported `tryAnswerQuestion(root, n, rawDecision, expectedTitle?: string): AnswerOutcome`, which runs under the same `withStateLock(primaryWorktreeLockPath(root), …)`. `AnswerOutcome` is `{ status: "answered"; title; decision } | { status: "missing"; open: number } | { status: "moved"; title: string } | { status: "fenced" }`. `missing` replaces the out-of-range `fail`, and `fenced` replaces the unclosed-fence `fail`. `moved` is new: when `expectedTitle` is given and the block at position `n` has a different `title`, the core writes nothing. Do the comparison inside the lock, after `scanQuestions`, so a question answered or added between the operator's poll and the click is never answered by mistake.
   - Keep `answerQuestion(root, n, rawDecision)` as the CLI entry point. It calls `tryAnswerQuestion` without `expectedTitle` and maps `missing`/`fenced` to the existing `fail(...)` messages, which stay byte-for-byte the same (`no question at position ${n} (${open} open)` and the unclosed-fence sentence). Move the message strings into the mapper, and update the doc comments on both functions.
2. `src/gui/gui-endpoint-commands.ts`: add `handleQuestionAnswer(req, res, root)`, documented like its siblings. It reads the body with `readPostBody(req, res, '{"position": 1, "title": "<heading>", "decision": "..."}')`. Answer 400 when `position` is not a positive integer, when `title` is not a non-empty string, or when `decision` is not a string or is blank after trimming. Use the same validation messages as the CLI where one exists (`questions answer needs a decision`). Then call `tryAnswerQuestion(root, position, decision, title)` and respond:
   - `answered` → 200 `{ ok: true, status: "answered", question: title, decision }`, the decision as written to the file (the collapsed text).
   - `missing`/`moved` → 200 `{ ok: true, status: "gone" }`. This matches `/api/prompt-cancel`'s `gone`: the outbox moved on, which is data for the flash line, not a fault.
   - `fenced` → 409 `{ ok: false, error: <the CLI's unclosed-fence sentence> }`.
   - A thrown filesystem error is answered 400, following `handleConfigSet`'s failed-write precedent.
3. `src/gui/gui-server.ts`: route `"POST /api/question-answer": (req, res) => handleQuestionAnswer(req, res, root)` beside `/api/prompt-edit`, under the same token gate as every other POST.

**Files touched.** `src/cli/question-commands.ts`, `src/gui/gui-endpoint-commands.ts`, `src/gui/gui-server.ts`, `test/question-commands.test.ts`, `test/gui-endpoints.test.ts`.

**Acceptance criteria.**
- The existing `test/question-commands.test.ts` cases pass unchanged, including the out-of-range and unclosed-fence cases that capture `process.exit` and the exact stderr.
- New `tryAnswerQuestion` tests show that `missing`, `moved` (where `expectedTitle` names the entry that was at position `n` before an earlier answer shifted it), and `fenced` each return without exiting and leave QUESTIONS.md byte-identical. `answered` produces the same file bytes as `answerQuestion` does on the same input.
- `test/gui-endpoints.test.ts` drives `handleQuestionAnswer` through `fakeReq`/`captureJson`, covering: an answer moving the entry to `## Answered` with the `**Answered <today> by operator:**` stamp and a 200 `answered` payload; a stale title and an out-of-range position each giving 200 `gone` with the file untouched; a blank decision, a non-integer position, and a missing title each giving 400; and an unclosed fence in `## Open` giving 409, with the process still alive and the file untouched.
- `npm run test` is green.

### Filter the TUI Activity feed by loop and text, matching the dashboard Activity filter and `tumwater logs --grep` (planned 2026-10-12 by plan; sibling of the landed TUI Activity page-back (`activityScroll`/`ACTIVITY_EVENTS` in `tui-pane.ts`) and the landed dashboard Activity loop/text filter (`gui-client-fleet.ts`'s `feedRole`/`feedText` and its `/api/logs` search) plus the landed `GET /api/logs` slice endpoint (`handleLogs`); the pane pages through the newest `ACTIVITY_EVENTS` events but cannot narrow them, while the CLI (`tumwater logs --grep`) and the dashboard's Loop picker + Search can, so an operator watching one loop or hunting one failure must scan the whole feed; independent of the waiting TUI prompt-line defer (`Ctrl+L`) and TUI Queued-pane edit (`Ctrl+E`) plans in behavior — its own `activityRole`/`activityGrep` state, its own `Ctrl+G` branch on view 0, and its own `/` target — though all three edit `tui-keys.ts`/`tui-frame.ts`/`tui.tsx`, so a landing conflict is possible and the resolver handles it; it reads the same events the pane already loads (`readEvents(root, ACTIVITY_EVENTS)`) and adds no endpoint, so its filter can only narrow what the feed shows; the match rules come from `eventMatchesGrep`/`eventRole`, the same homes `tumwater logs --grep` and `handleLogs` use; done 2026-10-12 by feature)

**Goal.** Let the operator narrow the TUI Activity pane by loop and by free text, using the dashboard's own Loop-picker + Search semantics and `tumwater logs --grep`'s match rule, over the loaded event tail the pane pages through: `Ctrl+G` cycles the pane's loop scope (fleet, then each raw roster id) and `/` opens a search on the prompt line whose Enter filters the feed.

**Approach.**
1. `src/ui/tui/tui-pane.ts`: import `eventRole` from `../../events/event-read.js` and `eventMatchesGrep` from `../../events/event-format.js` (beside the existing `readEvents`). Add and export `activityEvents(root: string, role: string | null, grep: string | null): HarnessEvent[]` = `readEvents(root, ACTIVITY_EVENTS).filter((e) => (role === null || eventRole(e) === role) && (grep === null || eventMatchesGrep(e, grep.toLowerCase())))` — one shared read+filter so the pane body and the PgUp/PgDn total cannot drift. In the Activity branch read those instead of calling `readEvents` directly, window them as today, and return `emptyNote: "(no events match this filter)"` when a filter is active and the read matched nothing. Widen the `activity` variant of `TuiView` (in `tui-frame.ts`) with `role: string | null; grep: string | null` so `paneBody` reads them from the pane, like the `history` variant.
2. `src/ui/tui/tui-keys.ts`:
   - Add `let activityRole: string | null = null` and `let activityGrep: string | null = null` beside `activityScroll`, plus `let searchFor: "history" | "activity" = "history"` (the target of the shared `searchMode` editor).
   - Add `activityRole` and `activityGrep` to `TuiKeysState` and `state()`, and clear `activityRole` in `syncSnapshot` when the incoming roster no longer names it (mirroring the `historyRole` cleanup).
   - Extend the `/` branch guard from `view === roleIds.length + 4` to `view === 0 || view === roleIds.length + 4`, set `searchFor = view === 0 ? "activity" : "history"`, and prefill the line with `(searchFor === "activity" ? activityGrep : historyGrep) ?? ""`.
   - In the Enter dispatch's `searchMode` arm, branch on `searchFor`: Activity sets `activityGrep = pattern === "" ? null : pattern`, calls `exitHistorySearch()`, resets `activityScroll = null` (the offset indexes the old filtered list), and flashes `search cleared` / `search: "<pattern>"`; History keeps today's cache-recompute path.
   - In the `Ctrl+G` branch add an `if (view === 0)` arm before the History arm cycling `activityRole` over `[null, ...roleIds]` (the same raw roster slots History uses) and resetting `activityScroll = null`; the History and report arms are unchanged.
   - In the Activity PgUp/PgDn handler replace the `readEvents(root, ACTIVITY_EVENTS).length` total with `activityEvents(root, activityRole, activityGrep).length`, keeping the existing `stepEntryScroll` clamp.
3. `src/ui/tui/tui-frame.ts`: the `activity` variant gains the two fields. `tabStrip` labels it `Activity${view.role ? ": " + view.role : ""}` (the History convention). `hintLine`'s Activity branch (the final `else`) gains `["Ctrl+G", view.role ? `scope: ${view.role}` : "scope: fleet"]` and `["/", view.grep ? `search: ${view.grep}` : "search"]` before the `Ctrl+T` hint (landed with `Ctrl+B daily cap` placed first, so the added keys do not push that key off a narrow terminal's clipped hint line).
4. `src/ui/tui/tui.tsx`: the terminal fallthrough becomes `{ kind: "activity", role: s.activityRole, grep: s.activityGrep }`.
5. `docs/how-it-works.md`: the Activity bullet names `Ctrl+G`'s loop scope and `/`'s text search, both over the loaded event tail, and says the text match rule is the same `eventMatchesGrep` the CLI and dashboard use.

**Files touched.** `src/ui/tui/tui-pane.ts`, `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`, `test/tui-keys.test.ts`, `test/tui.test.ts`, `test/tui-frame.test.ts`, `docs/how-it-works.md`.

**Acceptance criteria.**
- With events from two loops loaded, `Ctrl+G` on Activity cycles fleet → each raw roster id and back, the tab strip and hint line name the scope, and the pane shows only that loop's events (`eventRole(e) === scope`); a roster that drops the scoped id resets the scope to fleet.
- `/` on Activity with an empty prompt line opens the editor pre-filled with the active pattern; Enter filters the feed through `eventMatchesGrep`'s case-insensitive rule (the event's `type` plus its `formatEvent` line), so a pattern matching only a loop name or only a message matches exactly what `tumwater logs --grep` matches; an empty line clears it; Esc restores the saved director draft; `/` on any other view types into the prompt as today.
- Active filters compose with the existing PgUp/PgDn page-back: both clamp over the filtered list, and changing a filter resets the pane to the live tail (no scroll stranded past the filtered end).
- A filter that matches no event shows `(no events match this filter)` rather than a blank pane.
- The dashboard/CLI match rules remain the only rule homes — `activityEvents` calls `eventMatchesGrep`/`eventRole` and re-implements no haystack.
- `npm run test` is green.

### Edit a queued prompt in place from the TUI Queued pane, matching `tumwater prompt --edit` and the dashboard Queued tab's Edit (planned 2026-10-11 by plan; sibling of the landed TUI Queued pane (`renderQueuedList`, read-only), the landed `Ctrl+X` cancel (`cancelRolePrompt`), the landed dashboard edit (the part-1/2 `GET /api/prompt-text`/`POST /api/prompt-edit` over `readQueuedPromptBody`/`editQueuedFile`), and the waiting TUI prompt-line defer plan (`Ctrl+L`); the pane's `Ctrl+X` removes a selected prompt but no key rewrites one, so correcting a typo or an over-long instruction means dropping to the CLI or the browser; independent of the waiting `GET /api/logs` slice search in files — `src/ui/tui` plus one additive `QueuedListRow` field, no `src/gui` change; it shares `tui-keys.ts`/`tui-frame.ts`/`tui.tsx` with the waiting TUI activity-scroll and `Ctrl+L` defer plans, so a landing conflict is possible and the resolver handles it; done 2026-10-12 by feature)

**Goal.** Let an operator edit the selected queued prompt in place from the TUI Queued pane, through the same `readQueuedPromptBody`/`editQueuedFile` pair the dashboard's Edit uses (so the rewritten prompt keeps its position, enqueue stamp, `tumwater:not-before` deferral, and attached-image references). The pane already selects a row and cancels it with `Ctrl+X`; add a prompt-line editor, `Ctrl+E` (mnemonic: **E**dit), that pre-fills the line with the selected prompt's editable body and writes it back on Enter.

**Approach.**
1. `src/inbox/inbox.ts`: add `file: string` (the queue-file basename) to `QueuedListRow` and set it in `queuedListRows`'s `record` from the `e.file` `queuedRolePromptRecords` already carries. `renderQueuedList` ignores it; `prompt --list --json` gains the field additively (the CLI tests destructure named fields, and the empty payload is unchanged), and it is the address the edit writes back, so a concurrent dequeue cannot make a stale selection rewrite the wrong prompt — the same file-addressed policy the dashboard edit documents.
2. `src/ui/tui/tui-keys.ts`:
   - Import `readQueuedPromptBody` and `editQueuedFile` from `../../inbox/inbox-edit.js`.
   - Add session state `let queuedEditFor: { role: string; file: string } | null = null` beside `selectedQueued`, plus the saved-draft pair `queuedSavedInput`/`queuedSavedCursor`, and an `exitQueuedEdit()` mirroring `exitRolePromptMode`: clear `queuedEditFor`, restore the saved pair, `promptHistory = resetPromptRecall(promptHistory)`.
   - Expose `queuedEditFor` on `TuiKeysState` for the frame's `mode`.
   - Add a `Ctrl+E` branch before the existing report-window `Ctrl+E` branch, guarded to `view === roleIds.length + 6 && selectedQueued !== null && !budgetMode && !rolePromptFor && !searchMode && queuedEditFor === null`: settle the recall, save the draft, resolve `row = queuedRows[Math.min(selectedQueued, queuedRows.length - 1)]`, read `const body = readQueuedPromptBody(root, row.role, row.file)`. When `null` (the loop dequeued it or another operator cancelled it) flash `queued prompt #<position> for <role> is gone` and `refreshQueued()`. Otherwise set `queuedEditFor = { role: row.role, file: row.file }`, `input = body`, `cursor = body.length`, and flash `editing queued prompt #<position> for <role> — Enter to save, Esc to cancel`. Guard the report-window `Ctrl+E` branch with `queuedEditFor === null` so an edit-mode `Ctrl+E` is inert instead of moving the report window.
   - In the `Enter` dispatch add `else if (queuedEditFor)` before the director `else`: `parseRolePromptInput(input)` (already imported) rejects a whitespace-only body with a flash that stays in the editor; on `ok`, call `editQueuedFile(root, queuedEditFor.role, queuedEditFor.file, parsed.value)`: an `edited` outcome exits the mode, `refreshQueued()`, and flashes `edited queued prompt for <role>`; a `gone` outcome exits, refreshes, and flashes `queued prompt was already gone`; a throw flashes the reason and stays.
   - In the `Escape` dispatch add `else if (queuedEditFor) exitQueuedEdit()`; in the `Ctrl+T` branch call `exitQueuedEdit()` beside the budget and role-prompt exits.
   - Extend every existing `!budgetMode && !rolePromptFor && !searchMode` (and the `!budgetMode && !rolePromptFor` pair at `Ctrl+E`) guard to also exclude `queuedEditFor`, so the one prompt line stays mutually exclusive across all four editors.
3. `src/ui/tui/tui-frame.ts`: widen the `mode` parameter of `hintLine` and `promptPrefix` with `queuedEditFor: { role: string; file: string } | null`. `hintLine` gets a first branch `if (mode.queuedEditFor) keys = [["Enter", "save the edit"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]`, and the queued view's key list gains `["Ctrl+E", "edit"]` (plus `["Ctrl+X", "cancel"]`, which the landed cancel plan documented but never added to this line). `promptPrefix` returns `[{ text: \`edit ${mode.queuedEditFor.role}\`, tone: "brand" }, { text: " › " }]` while editing.
4. `src/ui/tui/tui.tsx`: the per-frame `mode` object literal gains `queuedEditFor: s.queuedEditFor`.
5. `docs/how-it-works.md`: the Queued-pane bullet adds the `Ctrl+E` edit through `readQueuedPromptBody`/`editQueuedFile`, matching `tumwater prompt --edit` and the dashboard's Edit alongside the `Ctrl+X` cancel.

**Files touched.** `src/inbox/inbox.ts`, `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`, `test/tui-keys.test.ts`, `test/tui-frame.test.ts`, `test/tui.test.ts` (the shared `TuiKeysState`/`TuiPaneState` literals gain the new fields as needed), `test/prompt-commands.test.ts` (the `--list --json` row now carries `file`), `docs/how-it-works.md`.

**Acceptance criteria.**
- With a director prompt and a second loop's deferred prompt queued, cycling to Queued, Down to the second row, and `Ctrl+E` pre-fills the prompt line with exactly that prompt's text minus its `not-before` marker and `[image attached: …]` block, and the prefix/hint name the edit target.
- Enter writes through `editQueuedFile` so the selected queue file is rewritten in place: its position, enqueue stamp, deferral marker, and attached images survive, and the pane refreshes to the same `renderQueuedList(queuedListRows(...))` the CLI prints.
- A whitespace-only line flashes `parseRolePromptInput`'s error and stays in the editor; Esc restores the director draft; a file gone between selection and Enter flashes the gone notice and returns to the list; `Ctrl+E` with no selection, or on any other view, keeps advancing the report window as today; `Ctrl+T` leaves the editor without writing.
- `npm run test` is green.

### Defer a prompt from the TUI prompt line, matching `tumwater prompt --at <duration>` and the dashboard composer's defer field (planned 2026-10-11 by plan; sibling of the landed CLI `tumwater prompt --at <duration>` (commit 654f15b3) and the landed dashboard defer (`src/gui/gui-endpoint-commands.ts`'s `checkedPromptFields` `defer` field threaded to `submitPrompt`/`submitRolePromptAndWake`); the TUI prompt line has `Ctrl+B` budget edit and `Ctrl+R`/`/` editors but no control that sets a prompt's `tumwater:not-before` marker, so an operator watching the terminal must drop to the CLI or the browser to schedule one; independent of the waiting TUI Queued-pane cancel and TUI Activity-scroll plans in behavior — its own `Ctrl+L` key, `deferMs` state, and prompt-line mode — though all three edit `tui-keys.ts`/`tui-frame.ts`/`tui.tsx`, so a landing conflict is possible and the resolver handles it; the waiting `GET /api/logs` plan touches no `src/ui/tui` file; no `src/inbox` or `src/gui` change beyond the existing `notBeforeMs` parameters on `submitPrompt`/`submitRolePromptAndWake`; done 2026-10-11 by feature)

**Goal.** Let the operator set a duration on the TUI prompt line that rides into the next delivered prompt as the same `tumwater:not-before <iso>` marker line (`src/inbox/prompt-not-before.ts`'s `notBeforeMarker`) `tumwater prompt --at <duration>` and the dashboard composer's defer field write, for both the director prompt and a role prompt. The prompt line already hosts three mutually exclusive editors (budget via `Ctrl+B`, role via `Ctrl+R`, History search via `/`); add a fourth, `Ctrl+L` (mnemonic: **l**ater), that stores a session-scoped delay applied at submit time and shown beside the prompt target.

**Approach.**
1. `src/ui/tui/tui-input.ts`: add a pure `parseDeferInput(text)` beside `parseBudgetInput`, importing `parseDurationMs` from `../../cli/cli-args.js` and `PAUSE_FOR_MAX_MS` from `../../operator/operator-intent.js` (already in the import graph of the TUI). Trimmed empty → `{ ok: true, ms: null }` (clear the delay, deliver now). A `parseDurationMs`-null spelling returns `{ ok: false, error: "defer needs a duration like 45s, 90m, 1h30m, or 2d" + gotSuffix(text) }` (`gotSuffix` is already imported here). A value over `PAUSE_FOR_MAX_MS` → `{ ok: false, error: "defer is capped at 90d" }` (the same wording the dashboard composer's server check uses). Otherwise `{ ok: true, ms }`.
2. `src/ui/tui/tui-keys.ts`:
   - Add `let deferMs: number | null = null` (a **duration in ms**, applied as `now() + deferMs` at submit — the factory's injectable clock, defaulting to Date.now; the CLI's `--at` is a delay, not an epoch), plus `let deferMode = false`, `let deferSavedInput = ""`, `let deferSavedCursor = 0`.
   - Add `exitDeferMode()` mirroring `exitBudgetMode`: restore the saved pair and `promptHistory = resetPromptRecall(promptHistory)`.
   - Add a `Ctrl+L` branch beside the `Ctrl+B` branch. If `budgetMode || rolePromptFor || searchMode`, flash the way out (extend `Ctrl+B`'s mirrored refusal the same way and add the defer case to its message). If `deferMode`, `exitDeferMode()`. Otherwise settle the recall, save the draft, set `deferMode = true`, prefill the line with `deferMs === null ? "" : durationLabel(deferMs)`, put the cursor at its end, and flash `defer the next prompt: a duration like 45m (empty sends now) — Enter to save, Esc to cancel`.
   - In the `Enter` dispatch, add an `else if (deferMode)` arm after the `budgetMode` arm: `parseDeferInput(input)`; on `ok` with `ms === null` reset `deferMs = null`, `exitDeferMode()`, flash `defer cleared`; on `ok` with a value set `deferMs = ms`, `exitDeferMode()`, flash `next prompt delivers in ${durationLabel(ms)}`; on error flash `parsed.error` and stay in the editor.
   - In the `Escape` dispatch add `else if (deferMode) exitDeferMode()`; in the `Ctrl+T` branch call `exitDeferMode()` beside the other two exits (leaving the editor without clearing `deferMs`).
   - Thread the delay into both submit paths and reset it after success: the director path calls `submitPrompt(root, prompt, undefined, deferMs === null ? undefined : now() + deferMs)` and the role path `submitRolePromptAndWake(root, role, parsed.value, undefined, ...)`; capture the pending `deferMs` before resetting so the success flash can append ` — delivers in ${durationLabel(pending)}` to `queued for the director loop`/`queued for the <role> loop` (the CLI's wording), then set `deferMs = null`.
   - Extend every existing `!budgetMode` mode guard to also exclude `deferMode` (the `Ctrl+F`, `Ctrl+R`, `Ctrl+N`, `Ctrl+G`, `Ctrl+E`, `Ctrl+S`, `Ctrl+O`, per-loop-control, and `/`-entry branches), since the defer editor holds the same one prompt line.
   - `state()` adds `deferMode: boolean` and `defer: string | null` (`deferMs === null ? null : durationLabel(deferMs)`).
3. `src/ui/tui/tui-frame.ts`: widen the `mode` parameter of `hintLine` and `promptPrefix` to `{ budget: boolean; rolePromptFor: string | null; deferMode: boolean; defer: string | null }`. `hintLine` gets a first branch `if (mode.deferMode) keys = [["Enter", "save the delay"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]`; when not in the editor it appends `["Ctrl+L", mode.defer ? "defer: " + mode.defer : "defer"]` to the chosen view's keys. `promptPrefix` returns `[{ text: "defer", tone: "brand" }, { text: " › " }]` while `mode.deferMode`, and otherwise names a pending delay in the target prefix (e.g. `director (defer 45m) › `).
4. `src/ui/tui/tui.tsx`: the per-frame `mode` object literal gains `deferMode: s.deferMode, defer: s.defer`.
5. `docs/how-it-works.md`: in the TUI operator-notes bullet, name `Ctrl+L` on the prompt line and that the pending delay is threaded into the next director or role prompt as the same `tumwater:not-before` marker `tumwater prompt --at` and the dashboard composer write.

**Files touched.** `src/ui/tui/tui-input.ts`, `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`, `test/tui-input.test.ts`, `test/tui-keys.test.ts`, `test/tui-frame.test.ts`, `docs/how-it-works.md`.

**Acceptance criteria.**
- With no delay set the prompt submits byte-for-byte as today (no marker); `Ctrl+L` then a valid duration then Enter sets a pending delay named in the prompt prefix and the `Ctrl+L` hint, and the next director **or** role submit passes `now() + ms` (Date.now() in production) as `notBeforeMs` so the queue file's first line is `notBeforeMarker`.
- A successful submit clears the pending delay (one-shot); an empty line in the editor clears it; an invalid spelling or a value over `PAUSE_FOR_MAX_MS` flashes and keeps the editor open; Esc restores the saved draft and leaves the pending delay unchanged.
- `Ctrl+L` while another editor holds the line flashes the way out and changes nothing; the other editors' guards refuse to open while `deferMode` is set.
- `parseDeferInput` returns `{ok:true, ms:null}` for empty/whitespace, the parsed ms for `45m`/`1h30m`/`90s`, and an error for `0h30m`, `junk`, and `91d`.
- The delay survives view cycling (Ctrl+T leaves the editor without clearing it) and is session-only (a fresh `createTuiKeys` starts with none).
- `npm run test` is green.

### Search the event log beyond the Activity card's carried window through a new `GET /api/logs` slice endpoint (planned 2026-10-11 by plan; sibling of the landed dashboard Activity loop/text filter (`gui-client-fleet.ts`'s `renderFeed`, which narrows only the events the 1-second `/api/status` poll carries, `status-payload.ts`'s `RECENT_EVENTS`) and the landed CLI `tumwater logs -n N --grep <text>` (`src/cli/log-commands.ts`'s `cmdLogs`, whose `-n` bounds the scanned tail and whose grep filters the matched subset); the card can filter but never reach past its window, so an operator hunting an older failure must drop to the CLI; independent of the waiting hermetic-host gating tier and the TUI Queued-pane cancel plan in files — `src/events`, `src/gui`, `src/ui/status-payload.ts`, and `src/ui/gui`, no `src/ui/tui` file and no test helper; done 2026-10-11 by feature)

**Goal.** Give the dashboard Activity card a server-backed search that scans a slice of the raw event log far larger than the events the status poll carries, using the CLI's own scan-then-filter rule, so the Loop picker and Search box can find an event that has scrolled out of the polled window.

**Approach.**
1. Single-home the two event facts the CLI and the card must agree on in `src/events/event-format.ts` (the event layer owns event-shaped concerns, the precedent `history-data.ts`'s `tickRowGrepHaystack` set for the tick haystack):
   - move `src/cli/log-commands.ts`'s private `matchesGrep` there as exported `eventMatchesGrep(e, patternLower)` — body unchanged, the case-insensitive substring over `` `${e.type} ${formatEvent(e)}` `` — and have `cmdLogs` call it;
   - move `src/ui/status-payload.ts`'s private `eventItem` there as exported `eventFeedItem(e)` (the same `{ ts, loop, type, result?, message }` shape through `eventRole`/`eventResult`/`eventMessage`) and have `statusPayload` map `recent` through it.
2. Add `handleLogs` to `src/gui/gui-endpoints.ts`: `GET /api/logs?n=N[&grep=<text>][&role=<id>]`. `n` parses through `intQuery(q, res, "n", "non-negative", LOGS_SEARCH_EVENTS)` then clamps to `[1, LOGS_SEARCH_MAX_EVENTS]` — two new module constants beside the handler (`LOGS_SEARCH_EVENTS = 500`, `LOGS_SEARCH_MAX_EVENTS = 5000`). Read the tail with `readEvents(root, n)` (the `cmdLogs` `-n` shape: n bounds the scanned tail, not the printed rows; the stat-keyed cached read, since the handler needs only the events and not `readEventsTailWithEnd`'s covered byte end), filter `role` through `eventRole(e) === role` and `grep` through `eventMatchesGrep`, and answer `{ events: matched.map(eventFeedItem) }` oldest-first. `role` is a filter, not a target, so it does not validate through `rejectBadRole` (the `handleHistory` rule: an id with no events legitimately yields an empty list).
3. Route it in `src/gui/gui-server.ts` beside `/api/history`: `"GET /api/logs": (_req, res, target) => handleLogs(target.searchParams, res, root)`, plus the import from `./gui-endpoints.js`.
4. `src/ui/gui/gui-client-fleet.ts`'s activity region: add `feedResults`, `feedSeq`, and `feedTimer` state. With no active filter (`feedRole` and `feedText` both empty) `renderFeed` keeps today's behavior byte-for-byte over `d.eventItems`. With an active filter, `renderFeed` still paints the locally-filtered window immediately (a keystroke narrows at once), while a debounced (250 ms) `fetchFeedSearch` calls `getJson(feedLogsQuery(), pollSignal())` with only the non-empty `grep`/`role` params and, when its `feedSeq` is still current, replaces the rows with the server's newest-first events (`d.events` reversed) and repaints via `renderFeed(lastStatus)`. Clearing both filters clears `feedResults` and repaints from the window; a failed fetch clears `feedResults` too and paints the card's search-empty state with a note that the running server may predate the endpoint (the `fetchHistDetail` wording).
5. Wording: with a server search active the empty state names the searched slice rather than the carried window (`No events match this filter in the log's recent slice`), so the card never implies it searched only the polled events. Update the `docs/how-it-works.md` Activity bullet ("A Loop picker and a case-insensitive Search box…") to say an active Loop/Search filter searches the log's recent slice through `/api/logs`, not only the carried window.

**Files touched.** `src/events/event-format.ts`, `src/cli/log-commands.ts`, `src/ui/status-payload.ts`, `src/gui/gui-endpoints.ts`, `src/gui/gui-server.ts`, `src/ui/gui/gui-client-fleet.ts`, `test/gui-endpoints.test.ts`, `test/gui-client-fleet.test.ts`, `docs/how-it-works.md`.

**Acceptance criteria.**
- `handleLogs` answers a `{ events }` array of `eventFeedItem`-shaped objects oldest-first; `grep` keeps only events whose `eventMatchesGrep` matches, `role` keeps only `eventRole === role`, and the two compose; the live server reaches it through `GET /api/logs`.
- `n` bounds the scanned tail (a matching event just older than the last `n` is absent from the answer), an explicitly bad `n` answers 400, and absent `n` uses `LOGS_SEARCH_EVENTS`.
- With no active filter the Activity feed's `#feed` markup is unchanged from today; with an active Search the card fetches `/api/logs` with the typed pattern and paints a returned event that is not in `eventItems`.
- A stale response (a later keystroke issued a newer request) never paints; clearing the filter restores the windowed feed and the byte-identical no-filter markup.
- `cmdLogs --grep` and the card's search both call `eventMatchesGrep`, and `statusPayload`'s `eventItems` come from `eventFeedItem` — one home each (also recorded as INV-A3).
- `npm run test` is green.

### Page the TUI Activity feed back through a loaded event tail, with the live tail as the default (planned 2026-10-11 by plan; sibling of the landed GUI Activity filter (`gui-client-fleet.ts`'s `renderFeed`) and the waiting `GET /api/logs` slice search; every other TUI pane scrolls its body, but the Activity pane's fallthrough branch in `tui-pane.ts` re-slices `readEvents(root, eventBudget)` to the newest `eventBudget` events on each frame and no key handler reads a scroll for view 0, so an operator watching the terminal can never look back at an event the feed has scrolled past, while the CLI (`tumwater logs -n N`) and the dashboard can; independent of the no-repro gating tier and the TUI Queued-pane cancel plan in behavior — `src/ui/tui/tui-pane.ts`, `tui-keys.ts`, `tui-frame.ts` plus tests and docs, no shared event helper and no new endpoint; done 2026-10-11 by feature)

**Goal.** Let the TUI's Activity pane page back through a fixed tail of the raw event log and return to the live tail, so the terminal surface can look back the way `tumwater logs -n N` and the dashboard already can, without adding a filter or an endpoint.

**Approach.**
1. `src/ui/tui/tui-pane.ts`: export a module constant `ACTIVITY_EVENTS = 200` beside `paneBody` (a tail term the stat-cached `readEvents` caches per `(file, limit)`, so a steady-state poll still costs one stat). Add `activityScroll: number | null` to `TuiPaneState` (`null` = follow the live tail). In the activity fallthrough branch read `readEvents(root, ACTIVITY_EVENTS)` once, compute `maxStart = Math.max(0, events.length - eventBudget)` and `start = state.activityScroll === null ? maxStart : Math.min(state.activityScroll, maxStart)`, and return `events.slice(start, start + eventBudget).map(...)`. The `null` branch yields the newest `eventBudget` events exactly as today's `readEvents(root, eventBudget).slice(-eventBudget)` does for the same log.
2. `src/ui/tui/tui-keys.ts`: add `let activityScroll: number | null = null` beside `paneScroll`, expose it through the state getter, and reset it to null in the Ctrl+T view-cycle handler beside the other per-view resets. Add a dispatch branch for the Activity view (index 0) on `pageDir`: read `const total = readEvents(root, ACTIVITY_EVENTS).length`, take the current start (`activityScroll ?? Math.max(0, total - eventBudget)`), move it by `eventBudget` in the page's direction clamped to `[0, maxStart]`, store the result in `activityScroll`, and set it back to `null` when the move reaches `maxStart` (the live tail resumes).
3. `src/ui/tui/tui-frame.ts`: the Activity fallthrough `hintLine` branch gains `["PgUp/PgDn", "scroll"]`.
4. `docs/how-it-works.md`: in the Ctrl+T view sentence around "cycles Activity, each loop's Transcript, …", add that Activity keeps the live tail and `PgUp`/`PgDn` page it back through a fixed 200-event tail, bottom resuming the tail.

**Files touched.** `src/ui/tui/tui-pane.ts`, `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `test/tui-keys.test.ts`, `test/tui.test.ts`, `docs/how-it-works.md`. The three existing tests that assert the Activity hint line or build a `TuiPaneState` literal were updated mechanically in the same change: `test/tui-frame.test.ts` (the Activity hint string) and `test/tui-history.test.ts` / `test/tui-backlog.test.ts` (the new required `activityScroll` field).

**Acceptance criteria.**
- With no scrolling (`activityScroll === null`) the Activity body is the newest `eventBudget` events — the same events today's read yields for the same log.
- PgUp on Activity pauses follow and shows older events; repeated PgDn returns to the loaded tail and re-enables follow; both directions clamp (oldest loaded event, live tail). A log with `eventBudget` or fewer events pages nowhere and does not crash.
- Cycling away and back to Activity starts at the live tail (the view cycle resets `activityScroll` to null).
- The Activity hint line names PgUp/PgDn as scroll.
- `npm run test` is green.

### Retire the `no-repro` gap, part 5/5: logical time for the supervisor's parent-death watch (planned 2026-10-11 by plan; split 2026-10-11 by plan from the steward's gating-tier plan; sibling of parts 1/5–4/5; independent of the TUI, dashboard, and agent-backends work; done 2026-10-11 by feature)

**Goal.** Convert the process-death family. `test/supervisor.test.ts`'s "startParentDeathWatch takes a SIGKILLed supervisor's grandchild down with it" waits on real watch budgets (15s start / 40s gone) that were widened after the flake recurred (BUGS.md 2026-10-09), so a loaded host decides the verdict.

**Approach.** Drive the grandchild watch's polls on logical time. The watch runs in the spawned grandchild process, so `test/helpers/wait.ts`'s `watchdogClock` (in-process `t.mock.timers`) cannot reach it; thread a clock/interval seam into `startParentDeathWatch` that the grandchild script selects through its environment (or an equivalent injected poll seam), and advance it from the test once the grandchild has started. Keep a bounded real-time guard only for the process plumbing (`SIGKILL`, reparenting, file creation), never for the watch's own verdict.

**Files touched.** `test/supervisor.test.ts`, `src/process/supervisor.ts` (`startParentDeathWatch`: the `poll` seam, and the stop-function return that lets a seam own its own cancel), `src/redeploy/self-reload.ts` (returns that stop in place of `clearInterval`). The seam landed as `opts.poll`, a `(check) => stop` defaulting to an unref'd interval; the two in-process watch tests were converted to a hand-fired poll too, so no watch test still sleeps on a real interval.

**Acceptance criteria.**
- The grandchild case reaches its verdict by advancing the injected watch clock, not by a real budget; a regression that drops the watch fails at that advance.
- The real-process plumbing (`SIGKILL` of the supervisor, reparent of the grandchild, the watch's stop-path file) is still exercised by a real child, with its own bounded guard.
- `npm run test` is green.

### Cancel a queued prompt from the TUI Queued pane, matching `tumwater prompt --cancel` and the dashboard Queued tab's Cancel (planned 2026-10-11 by plan; sibling of the landed TUI Queued pane (`renderQueuedList`, read-only) and the landed CLI `tumwater prompt --cancel` plus the dashboard Queued tab's per-row Cancel; the pane renders the list but no key can act on it, so cancelling a mis-typed or stale prompt means dropping to the CLI or the browser; independent of the waiting `no-repro` hermetic-host gating tier (parts 2/5, 4/5, 5/5) in behavior — `src/ui/tui` plus tests and docs, no `src/inbox` or `src/gui` change beyond reading the existing `cancelRolePrompt`; a later TUI edit sibling is not part of this plan; done 2026-10-11 by feature)

**Goal.** The TUI's Queued pane (`Ctrl+T` past Pending) renders `tumwater prompt --list`'s output through `renderQueuedList`, but it is read-only: `paneBody`'s queued branch only windows the cached string from `src/ui/tui/tui-keys.ts`'s `Ctrl+T` handler, and no key handler reads the queue. Add row selection and a cancel key to the pane so an operator can remove the selected prompt in place, through the CLI's own per-role `cancelRolePrompt` path.

**Approach.**
1. `src/ui/tui/tui-keys.ts`: add a session `selectedQueued: number | null` beside `selectedEntry` and expose it on `TuiKeysState`; the `Ctrl+T` handler resets it to null on every cycle, like `selectedEntry`. Keep the `QueuedListRow[]` the handler already builds for `renderQueuedList` (from `queuedListRows(root, null, listWideScope(root))`), so a selection can address a row's `role`/`position` without re-reading the queue each frame. Clear or clamp it whenever the view leaves Queued.
2. Key handling: in the Queued view (index `roleIds.length + 6`), Up/Down move `selectedQueued` through `tui-backlog.ts`'s `moveEntrySelection(count, selectedQueued, dir)` (the backlog pane's wrapping rule), a no-op when the queue is empty. `Ctrl+X` — unused elsewhere in `tui-keys.ts`'s dispatch — on a set selection calls `cancelRolePrompt(root, row.role, row.position)` from `src/inbox/inbox-cancel.ts`, re-reads the queue, refreshes the cached list and rows, clamps or clears the selection, and flashes `cancelled queued prompt #<position> for <role>` (or the outcome's own gone/miss wording via `flashError`). Esc returns the pane to list mode. `Ctrl+X` with no selection, and `Ctrl+X` in any other view, leaves the queue untouched.
3. `src/ui/tui/tui-pane.ts`: add `selectedQueued` and the rows to `TuiPaneState`; in the queued branch, list mode keeps the cached `renderQueuedList` string, and a set selection paints a bold header `queued for <role> #<position> (Ctrl+X to cancel)` over the selected prompt's full text windowed by `entryBodyWindow`, so a prompt the numbered list clipped is readable before cancelling.
4. `src/ui/tui/tui.tsx`: `state: s` already forwards the whole `TuiKeysState`, so the two new fields reach `paneBody` with no edit there; the queued rows and selection are read straight off the same state object.
5. `docs/how-it-works.md`: the Queued-pane bullet names the Up/Down selection and the `Ctrl+X` cancel through `cancelRolePrompt`'s per-role path, matching `tumwater prompt --cancel`.

**Files touched.** `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-pane.ts`, `src/inbox/inbox.ts` (export the existing `QueuedListRow` type), `test/tui-keys.test.ts`, `test/tui.test.ts`, `test/tui-backlog.test.ts` and `test/tui-history.test.ts` (the shared `TuiPaneState` literals gain the two required fields), `docs/how-it-works.md`.

**Acceptance criteria.**
- With a director prompt and a second loop's prompt queued, cycling to Queued, Down to a row, and `Ctrl+X` removes exactly that loop's prompt (its per-role position), leaves the other queued, and refreshes the pane's cached list to the same `renderQueuedList(queuedListRows(...))` the CLI prints for the remaining queue.
- The selected row's full text renders under a header naming its loop and position; `Ctrl+X` with no selection leaves the queue unchanged and does not modify the prompt line, and cycling away and back starts in list mode with no selection.
- A selection past a queue shortened by the cancel clamps rather than cancelling the wrong prompt.
- `npm run test` is green.

### Retire the `no-repro` gap, part 3/5: make `drainInFlightWork`'s restart windows injectable (planned 2026-10-11 by plan; split 2026-10-11 by plan from the steward's gating-tier plan; sibling of parts 1/5, 2/5, 4/5 and 5/5; independent of the TUI, dashboard, and agent-backends work; done 2026-10-11 by feature)

**Goal.** Convert the drain-window family. `src/tick/tick-timing.ts`'s `drainInFlightWork` bounds its restart hand-off with `handoffWindowMs` and real timers, and `test/tick-timing.test.ts`'s wedged-landing case asserts on `Date.now()` elapsed time (`assert.ok(elapsed >= 100 && elapsed < 5_000, …)`), so a loaded host can decide the verdict (BUGS.md 2026-09-30).

**Approach.**
1. Add an injected `AfterDelay` one-shot deadline-scheduler seam to `settlesWithin` and thread it through `awaitLandingForHandoff` and `drainInFlightWork` (defaulting to the real `setTimeout`), covering the hand-off window and the post-abort wait, so a test can cross both windows deterministically. Update the module's production caller to pass nothing — the default preserves behavior.
2. Convert `test/tick-timing.test.ts`'s three `drainInFlightWork` cases to drive the seam with hand-fired timers: the two settling cases assert the drain waited out the reserved tick and landing before returning, and the wedged-landing case arms and fires both windows on the injected scheduler rather than measuring elapsed wall time.

**Files touched.** `src/tick/tick-timing.ts`, `test/tick-timing.test.ts`.

**Acceptance criteria.**
- The wedged-landing case fails deterministically when the injected clock is not advanced and passes instantly when it is; no assertion reads `Date.now()` elapsed wall time.
- The two settling cases keep asserting the drain waited for tick and landing, driven by the seam.
- `npm run test` is green.

### Retire the `no-repro` gap, part 4/5: logical time for the fallback-breaker cool-down (planned 2026-10-11 by plan; split 2026-10-11 by plan from the steward's gating-tier plan; sibling of parts 1/5, 2/5, 3/5 and 5/5; test-only, independent of the TUI, dashboard, and agent-backends work; done 2026-10-11 by feature)

**Goal.** Convert the cooldown family. `test/orchestrator-probe.test.ts`'s "a demoted fallback admits exactly one probe tick per cool-down; other due roles wait" already injects `breakerNow` (via `RunOptions.breakerNow`) but still leans on real `sleep(300)` gaps to let a broken cooldown check probe or not, so a loaded host's overshoot reads as a pierced pause (BUGS.md 2026-10-07).

**Approach.** Replace the `sleep(300)` "a full poll cycle or two" gaps with assertions on the injected breaker clock: the wake must not move `breakerNow` past the published `probeAt`, and a broken cooldown check is caught by advancing `breakerNow` by one poll without waking a tick. Keep the real `sleep` only if a real poll cycle is what establishes the absence of a tick, and if so pair it with an advance of `breakerNow` so the verdict no longer depends on host load. Landed as: the injected `breakerNow` is also a poll-read counter, and both hold assertions wait until the loop has weighed the cool-down twice under a still-future `probeAt` before checking no tick ran — no real sleep remains, and dropping `fallbackProbeDue`'s `now >= b.probeAt` guard fails the first assertion.

**Files touched.** `test/orchestrator-probe.test.ts` (and the INV-F1 register entry that cites its regression).

**Acceptance criteria.**
- The cooldown case goes red deterministically when the cooldown check is removed, with no verdict left to a real `sleep` overshoot.
- The "exactly one probe per cool-down" and "other due roles wait" assertions still hold after the conversion.
- `npm run test` is green.

### Filter the dashboard Activity feed by loop and text over the events the card already carries, matching `tumwater logs --grep`/`logs --role` (planned 2026-10-11 by plan; sibling of the landed CLI `tumwater logs --grep <text>`/`--role <id>` and the landed dashboard History search plus Loop picker (`gui-client-history.ts`'s `#histgrep`/`#histrole`); the Activity card's only narrowing is the Notable/All segmented filter (`gui-page.ts`'s `#feedfilter`, `gui-client-fleet.ts`'s `renderFeed`), so an operator watching one loop's events or hunting a specific failure must drop to `tumwater logs` or scan the whole recent feed; independent of the waiting hermetic-host gating tier, dashboard composer defer, and TUI History tick-trail plans in code — `src/ui/gui` only, no `src/ui/tui`, `src/inbox`, or `src/gui` file; it reads the event window the card already receives (`status-payload.ts`'s `RECENT_EVENTS` `eventItems`) and adds no endpoint, so its filter cannot disagree with what the card shows, only narrow it; done 2026-10-11 by feature)

**Goal.** The dashboard's Activity card carries the last `RECENT_EVENTS` events as `eventItems`
and can filter them to the notable ones, but not by loop or by text. The History view already has
both (`#histrole` picker and `#histgrep` search, the search running through the shared haystack
rule `tumwater history --grep` uses), so the narrower Activity card is the odd one out. Add a Loop
picker and a text box to the card's header that filter the events it already carries, with the
same persistence (`store`/`recall`) the card's Notable/All choice uses, so an operator can watch
one loop's recent events or find a recent failure without leaving the main screen.

**Approach.**
1. `src/ui/gui/gui-page.ts`: in the Activity card's `<header class="card-head">`, beside
   `<div class="seg" id="feedfilter">`, add `<label><span class="sr-only">Loop</span><select
   class="field" id="feedrole"><option value="">All loops</option></select></label>` and
   `<label><span class="sr-only">Search</span><input class="field" id="feedgrep"
   type="search" placeholder="Search activity…" autocomplete="off"></label>`, mirroring the
   History toolbar's `#histrole`/`#histgrep` markup.
2. `src/ui/gui/gui-client-fleet.ts`: wrap the activity state, helpers, and listeners in
   `// activity:start` … `// activity:end` region markers (the `// backlog:start`/`:end` pattern
   in the same file), so `test/gui-client-fleet.test.ts` can run them through `clientScope`.
   - Extend the existing activity state beside `let feedFilter …`: `let feedRole =
     recall("feed-role") || "";`, `let feedText = recall("feed-grep") || "";`, and a
     `let feedRolesKey = "";` cache key.
   - Add `syncFeedRoles(d)`, following `gui-client-history.ts`'s `syncHistoryRoles`: rebuild the
     `#feedrole` options from `(d.loops || []).map((l) => l.role)` through the shared
     `rolePickerOptions` helper, keying on `roles.join(",")` so a poll with no roster change
     repaints nothing; keep `feedRole` in step with the repainted picker (a role the fleet
     dropped resets to `""` and persists), the same rule the History picker applies.
   - In `renderFeed(d)`, call `syncFeedRoles(d)` first. Keep the existing newest-first slice and
     Notable/All filter, then apply the loop filter (`it.loop === feedRole` when `feedRole` is
     non-empty) and the text filter (`(it.loop + " " + it.type + " " + it.message).toLowerCase().includes(feedText.toLowerCase())`
     when `feedText` is non-empty). Keep the `#feedrole` select in step with the state on every
     paint, but restore `#feedgrep` from `feedText` once at load and leave it untouched on later
     paints — rewriting it every poll would wipe the operator's in-progress typing before the
     committed text catches up. Choose the empty-state wording by whether the notable-filtered
     set was itself non-empty: no events at all keeps today's `No events yet` / `Nothing notable
     lately`, and events the Notable/All choice already removed keep `Nothing notable lately`, so
     `No recent events match this filter` with a `data-action='feedclear'` button (which resets
     `feedRole`/`feedText`, clears both inputs, persists `""` for each, and re-renders) appears
     only when the Loop/Search filter is what emptied the feed. While no
     filter is active the rendered rows stay byte-identical to today's.
   - Wire `$("feedrole").addEventListener("change", …)` and
     `$("feedgrep").addEventListener("input", …)` beside the existing `$("feedfilter")`
     listener (the markup `gui-page.ts` always ships), each storing its key and calling
     `renderFeed(lastStatus)`; add one delegated `$("feed").addEventListener("click", …)` arm for
     the `feedclear` button (the empty state's `#feed` is static markup, so the listener
     registers at load like `$("feedfilter")`'s).
3. `docs/how-it-works.md`: in the dashboard Activity sentence, note the Loop picker and text box
   narrow the recent-event feed to one loop or a case-insensitive substring, persisted like the
   Notable/All choice.

**Files touched.** `src/ui/gui/gui-page.ts`, `src/ui/gui/gui-client-fleet.ts`,
`docs/how-it-works.md`, `test/gui-client-fleet.test.ts`.

**Acceptance criteria.**
- `test/gui-client-fleet.test.ts` gains a `feedScope` helper building `clientScope` over the
  `activity` region (plus whatever shared regions `renderFeed` reaches) with a `paintPanel` stub,
  a `$` stub returning the `#feedfilter`/`#feedrole`/`#feedgrep` stand-ins, and a `rolePickerOptions`
  stub; the new cases:
  - with `feedRole` set to a role present in `eventItems`, `renderFeed` paints only that loop's
    items (the other loop's message is absent from the painted HTML);
  - with `feedText` set, the match is case-insensitive over loop/type/message (a lower-cased
    needle matches an upper-cased message and vice versa);
  - a text filter that removes every carried event paints `No recent events match this filter`
    and a `data-action='feedclear'` button, while an empty `eventItems` still paints today's
    `No events yet`;
  - with neither filter set the painted HTML is byte-identical to the unfiltered render;
  - a render whose committed `feedText` differs from the box's live value leaves that value
    untouched (an in-progress query survives the poll), and a window the Notable-only choice
    emptied keeps `Nothing notable lately` rather than the filter empty state.
- `test/gui-client-fleet.test.ts` asserts (as it does for the queued-edit wiring) that
  `GUI_CLIENT_FLEET_JS` reaches `store("feed-role"` and `store("feed-grep"`, and — importing
  `GUI_PAGE` from `../src/ui/gui/gui-page.js` — that the page ships `id="feedrole"` and
  `id="feedgrep"` inside the Activity card's header.
- `npm run test` is green.

### Retire the `no-repro` gap, part 1/5: state the deterministic-hermetic rule and add the gating-tier guard (planned 2026-10-11 by plan; split 2026-10-11 by plan from the steward's "A deterministic-time, hermetic-host gating tier" plan, which feature judged too large for one run; siblings parts 2/5–5/5 convert the measured-time families; docs-and-tests only, no `src/` change; independent of the TUI Queued pane, TUI History, dashboard, and agent-backends work; done 2026-10-11 by feature)

**Goal.** Retire the `no-repro` validation gap — the tally (`grep -oE 'gap:[*]{0,2} ?[a-z-]+' BUGS.md | sed -E 's/^gap:[*]{0,2} ?//' | sort | uniq -c`) shows it on 48 Fixed entries, the largest non-`none` tag with no retiring infrastructure plan — by stating, once in the register, the rule parts 2/5–5/5 enforce: a gating-tier (`*.test.ts`, not `*.e2e.test.ts`) test probes no live host (`lsof`, `top`, `sysctl`, `/proc`) and binds no real listener; a test that asserts a deadline, window, backoff, or poll interval takes its clock from an injected seam (`test/fakes/time.ts`'s `fakeClock`/`sleepRecorder`, `test/helpers/sleep-clock.ts`'s `scriptedSampler`, or `test/helpers/wait.ts`'s `watchdogClock`); and a flake's fix converts the failing case to a deterministic regression instead of widening its budget.

**Approach.**
1. Add an invariant entry to `docs/invariants.md` (new section "Hermetic, deterministic gating tests", id `INV-F1`) with the **Guarantee** / **Binds** / **Pinned by** fields, citing the guard below and the part 2/5–5/5 regression cases.
2. Add a scanning test to `test/invariants-doc.test.ts` — the register's own guard — that enumerates the gating test sources under `test/` (skipping `*.e2e.test.ts`) and reports every live-host probe spawn (`lsof`/`top`/`sysctl`/`/proc`) or real listener bind (`listen(`/`createServer`), unless the file is on a small explicit allowlist naming why. Factor the scan into a pure helper like the file's existing `invariantProblems(md)`, so a test can feed it planted source strings instead of writing files.

**Files touched.** `docs/invariants.md`, `test/invariants-doc.test.ts`.

**Acceptance criteria.**
- The helper flags a planted `lsof` spawn and a planted `listen(` in a gating source string, and flags nothing in an `*.e2e.test.ts` string.
- `docs/invariants.md` carries `INV-F1` with resolvable `test/...` citations; `test/invariants-doc.test.ts`'s existing register checks stay green.
- `npm run test` is green.

### Retire the `no-repro` gap, part 2/5: an injected clock for the wait/deadline helpers and their callers (planned 2026-10-11 by plan; split 2026-10-11 by plan from the steward's gating-tier plan; sibling of parts 1/5, 3/5, 4/5 and 5/5; test-only, no `src/` change; independent of the TUI, dashboard, and agent-backends work; done 2026-10-11 by feature)

**Goal.** Convert the poll-deadline family. `test/helpers/wait.ts`'s `waitFor` and `waitForFile` read `performance.now()` and poll with the real `sleep`, and `test/helpers/cli-harness.ts`'s `spawnCli.waitFor` does the same for a spawned CLI's output, so a loaded host can spend a readiness budget the test never intended and report the spent deadline as a product regression (the cold-start GUI banner wait, BUGS.md 2026-10-07).

**Approach.**
1. `test/helpers/wait.ts` exports a `WaitClock` (`now`/`sleep`) with a `liveWaitClock` default of `performance.now()`/the real `sleep`; `waitFor` and `waitForFile` take it as an optional trailing argument, so every existing caller is unchanged. `watchdogClock` already freezes `Date`/`setInterval`; the new seam is what lets a test cross a `performance.now()` deadline instantly.
2. `spawnCli.waitFor` (`test/helpers/cli-harness.ts`) takes the same `WaitClock` and polls through it (its interval became a `clock.sleep(100)` chain), defaulting to `liveWaitClock`.
3. Converted `test/cli-logs.test.ts`'s "logs -f --json streams each newly landed event as a JSON line" test: the live-event wait takes a frozen `fakeClock`, whose deadline no host load can spend, and a sleep that resolves on the child's next stdout chunk, so the event is observed when it streams; the test asserts the wait's synchronous first poll parked on that injected sleep, so it fails if the wait falls back to the live clock. A bounded fallback crosses the frozen deadline only if the child never streams. The child process's own 500 ms `followFile` poll is the product under test and the only real delay the success path leaves. Added "logs -f's wait expires on the injected clock, not a real deadline", which drives a hand-driven clock whose `sleep` parks: the test asserts the wait parked, is unsettled before the advance, then advances `now` and releases the poll to reject. Added `test/wait.test.ts`, pinning `waitFor`'s and `waitForFile`'s expiry and `waitFor`'s success path on a `fakeClock`.

**Files touched.** `test/helpers/wait.ts`, `test/helpers/cli-harness.ts`, `test/cli-logs.test.ts`, `test/wait.test.ts`.

**Acceptance criteria.**
- `waitFor`/`waitForFile`/`spawnCli.waitFor` with a `fakeClock` expire when the test advances the clock and no longer read a real deadline; with no seam passed they read `performance.now()`/the real `sleep` as before.
- The `logs -f --json` follow test's deadline is the injected clock (no host load can spend it); the added regression rejects deterministically when the clock crosses the budget.
- `npm run test` is green.

### Drill into one tick's event trail from the TUI History pane, matching `tumwater tick <role> --last` (planned 2026-10-11 by plan; sibling of the landed CLI `tumwater tick <role> [<n>] [--last]` and the landed dashboard History drill-down (`GET /api/tick` serving `readTickDetail` through `renderTickDetail`); the TUI History pane lists the completed-tick rows (`readTickRows`/`historyPaneText`) but has no drill-down, so an operator watching the terminal must drop to the CLI or the browser to see one tick's events; read-only and synchronous (no server, mutation, or async collector), so it needs no `src/inbox` or `src/gui` file; independent of the waiting dashboard queued-prompt edit, dashboard defer, and TUI pending-change plans in behavior — though it shares `tui-keys.ts`/`tui-frame.ts`/`tui.tsx`/`tui-pane.ts` with the TUI pending-change plan, its own History `Ctrl+N` branch rather than that plan's transcript `changeMode`, so a landing conflict is possible and the resolver handles it; done 2026-10-11 by feature)

**Goal.** `tumwater tick <role> [<n>] [--last]` prints one completed tick's full event trail — a
summary header followed by the tick's events through `formatEvent` — and the dashboard's History
drill-down serves the same `renderTickDetail` text from `readTickDetail`. The TUI History pane
shows only the one-line rows, so the terminal cannot see a tick's events. Add a read-only trail
view on the History pane, rendered from the same `readTickDetail`/`renderTickDetail` pair, so the
three surfaces cannot drift on the header or the event rendering.

**Approach.**
1. `src/ui/tui/tui-keys.ts`:
   - Add imports `readTickDetail` from `../../tick/tick-detail-data.js` and `renderTickDetail`
     from `../../tick/tick-detail.js` (`readTickRows` is already imported).
   - `TuiKeysState` gains `trailMode: boolean` and `trailCache: string | null` with doc comments
     paralleling `noteMode`/`noteCache`: `trailMode` is true only on the History view while its
     pane shows one tick's trail, and `trailCache` is `renderTickDetail`'s text. Add the locals
     `let trailMode = false; let trailCache: string | null = null;` beside `noteMode`/`noteCache`.
   - In the `Ctrl+N` handler, add a History arm *before* the existing transcript guard (which
     currently returns early for non-transcript views, so it would swallow the key): when
     `view === roleIds.length + 4 && !budgetMode && !rolePromptFor && !searchMode`, toggle
     `trailMode`. On entry, read the newest completed tick through
     `readTickRows(root, 1, historyRole)[0]` — the scoped loop's newest when `historyRole` is set
     (`Ctrl+G`), else the fleet's newest, whose `row.loop`/`row.tick` address the detail — then
     `readTickDetail(root, row.loop, row.tick)`, set `trailCache = detail ? renderTickDetail(detail) : null`,
     and `trailMode = true`; no row flashes `"no completed ticks to inspect"` and leaves normal
     History mode. Catch a collector throw like the notebook arm (clear `trailCache`, `flashError`).
     Off entry (`trailMode` true) clear both; set `paneScroll = 0` on every transition.
   - The `Ctrl+T` branch clears `trailMode = false; trailCache = null;` beside the notebook reset,
     so a cycle away drops the snapshot.
   - The `page !== null && noteMode` scroll branch becomes `page !== null && (noteMode || trailMode)`,
     windowing `noteMode ? (noteCache ?? "") : (trailCache ?? "")`.
   - `state()` returns the new `trailMode` and `trailCache`.
2. `src/ui/tui/tui-frame.ts`: `TuiView`'s history variant gains `trail: boolean` beside `grep`;
   `tabStrip`'s history label reads `${view.trail ? "Tick" : "History"}${view.role ? ": " + view.role : ""}`;
   `hintLine`'s history `Ctrl+N` word becomes `view.trail ? "history" : "tick trail"`.
3. `src/ui/tui/tui.tsx`: the history `pane` object gains `trail: s.trailMode`.
4. `src/ui/tui/tui-pane.ts`: `TuiPaneState` gains `trailCache: string | null` (its `noteCache` doc
   retargeted to "the notebook view's rendered Markdown"); the history branch gains, before the
   normal rows, an `if (pane.trail)` case that windows `state.trailCache` through
   `entryBodyWindow` exactly like the notebook (`toneLine` with no extra tone) and returns
   `emptyNote: "(no tick trail)"` while the cache is null.
5. `docs/how-it-works.md`: the TUI History paragraph (the `Ctrl+S`/`Ctrl+O`/`Ctrl+G`/`/`
   sentences) adds that `Ctrl+N` swaps the pane for the newest completed tick's full event trail
   — the loop's newest when `Ctrl+G` scopes the pane, else the fleet's newest — rendered from the
   same `readTickDetail`/`renderTickDetail` pair `tumwater tick --last` and the dashboard's
   History drill-down use, with the tab strip reading `Tick` and `Ctrl+N` again returning to the
   rows.

**Files touched.** `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`,
`src/ui/tui/tui-pane.ts`, `docs/how-it-works.md`, `test/tui-frame.test.ts`,
`test/tui-keys.test.ts`, `test/tui-history.test.ts` (the `paneBody` tests' home, not
`test/tui.test.ts` as planned), and `test/tui-backlog.test.ts` (its `TuiPaneState` literal gained
`trailCache`).

**Acceptance criteria.**
- `test/tui-frame.test.ts`: every existing history literal gains `trail: false` (the field is
  required), keeping the `History`/`History: <role>` labels green; a `trail: true` case tab-strips
  `[Tick: qa]` and hints `Ctrl+N history`, while a `trail: false` history hint stays `tick trail`.
- `test/tui-keys.test.ts`, new case seeding a completed tick with `writeEvents(root, [{ loop:
  "clean", type: "tick_start", tick: 1, ts: … }, { loop: "clean", type: "tick_end", tick: 1, ts:
  …, result: "changed", summary: "work" }])`, `syncSnapshot(0, false, ["clean"])`, then `Ctrl+T`
  to the History view (`roleIds.length + 4`): the first `Ctrl+N` sets `trailMode` true and
  `trailCache` matching `renderTickDetail(readTickDetail(root, "clean", 1))`, the second clears
  both, and a `Ctrl+T` while in trail mode clears it. A separate empty-log case flashes `no
  completed ticks to inspect` and leaves `trailMode` false; a second completed loop covers the
  `Ctrl+G` scope choosing the scoped loop's newest trail.
- `test/tui-history.test.ts`: a `paneBody` case for a history pane with `trail: true` windows
  `state.trailCache` and returns `(no tick trail)` when it is null.
- `docs/how-it-works.md` names the History `Ctrl+N` drill-down and `tumwater tick --last`.
- `npm run test` is green.

### Defer a prompt from the dashboard composer, matching `tumwater prompt --at <duration>` (planned 2026-10-11 by plan; sibling of the landed CLI `tumwater prompt --at <duration>` (commit 654f15b3) and the landed dashboard deferral display (`gui-client-fleet.ts`'s `delivers in`); the dashboard can already paint a deferred prompt's countdown but no dashboard surface can set the marker, so an operator must drop to the CLI to schedule one; independent of the waiting TUI Queued pane, TUI History grep, dashboard queued-prompt edit, and dashboard Settings Clear plans in code — `src/cli/cli-args.ts`'s newly exported `parseDurationMs` plus `src/inbox/inbox-submit.ts`, the two prompt handlers in `src/gui/gui-endpoint-commands.ts`, and the composer files, no `src/ui/tui` file — it shares `src/gui/gui-endpoint-commands.ts` with the landed prompt-edit and Settings Clear handlers but edits different functions, so a landing conflict is possible and the resolver handles it; done 2026-10-11 by feature)

**Goal.** `tumwater prompt --at <duration>` queues a prompt whose `tumwater:not-before <iso>`
marker line (`src/inbox/prompt-not-before.ts`'s `notBeforeMarker`) keeps it out of execution
order until the duration passes; the marker rides through the one `enqueueRolePrompt` atomic
write and every display surface strips it (`stripNotBeforeMarker`). The dashboard's
`/api/prompt` and `/api/prompt-role` never set it and the composer has no control for it, so a
deferred prompt can be shown (`gui-client-fleet.ts`'s `delivers in …`) but not created from the
browser. Add an optional defer field to the composer and thread the parsed delay to the same
submit path the CLI uses, so the two surfaces cannot disagree on the grammar or the marker.

**Approach.**
1. `src/cli/cli-args.ts`: add `export` to the existing private `parseDurationMs` (leave
`UNIT_MS`/`UNIT_ORDER` private), keeping its doc comment and body unchanged. `parseDurationFlag`
and `durationLabel` are untouched (same definitions, same `fail()` wording), so every existing
importer and `test/cli-args.test.ts`'s duration cases stay green. Exporting the grammar's own
parser gives the server a function that returns `null` instead of ending the process through
`parseDurationFlag`'s `fail()` wrapper, and there is still one copy of the grammar.
`src/operator/operator-intent.ts` and `src/inbox/prompt-commands.ts` already import
`durationLabel` from this module, so the import edge exists; the new caller is only one more.
2. `src/inbox/inbox-submit.ts`: `submitPrompt` gains the `notBeforeMs?: number` parameter its
role sibling `submitRolePrompt` already has and forwards it (`submitRolePrompt(root,
DIRECTOR_ROLE, text, images, notBeforeMs)`).
3. `src/gui/gui-endpoint-commands.ts`:
   - Extend `checkedPromptFields` to read an optional `defer` field before it returns: absent →
no deferral; a non-string, blank, or `parseDurationMs`-null value (imported from
`../cli/cli-args.js`) → 400 `{ error: "defer needs a duration like 45s, 90m, 1h30m, or 2d" }`
and return null; a parsed value over
`PAUSE_FOR_MAX_MS` (imported from `../operator/operator-intent.js`, the same 90d cap the CLI's
`failOverDurationCap` applies) → 400 `defer is capped at 90d`. Return `{ text, images,
notBeforeMs }` with `notBeforeMs = Date.now() + ms` when a defer was given, `undefined`
otherwise.
   - `handlePrompt` passes `fields.notBeforeMs` to `submitPrompt`; `handlePromptRole` passes it
to `submitRolePromptAndWake` (which already accepts it).
4. `src/ui/gui/gui-page.ts`: the composer's `composer-foot` gains a labelled compact input
`<input class="field" id="promptdefer" type="text" placeholder="defer (45m)"
autocomplete="off">` (its `<label>` carries `sr-only` text) beside `prompthint`.
5. `src/ui/gui/gui-client-composer.ts`:
   - `sendPrompt(target, text, images, defer)` adds a `defer` key to the POST body only when
the trimmed value is non-empty, and appends ` — delivers in <defer>` to the confirmation for a
deferred prompt (echoing the operator's own spelling, like the CLI's `durationLabel` echo).
   - The submit handler reads `$("promptdefer").value.trim()`, passes it, and clears the input
only after a successful send (kept on a refusal, like the text and the images). Whitespace-only
text is still the no-op it is today.
6. `docs/how-it-works.md`: the dashboard Fleet bullet's prompt-box sentence adds that the
composer can defer a prompt by a duration, using the same grammar and `tumwater:not-before`
marker `tumwater prompt --at` uses.

**Files touched.** `src/cli/cli-args.ts`, `src/inbox/inbox-submit.ts`,
`src/gui/gui-endpoint-commands.ts`, `src/ui/gui/gui-page.ts`,
`src/ui/gui/gui-client-composer.ts`, `test/gui-operator.test.ts`,
`test/gui-client-composer.test.ts`, `docs/how-it-works.md`.

**Acceptance criteria.**
- `test/gui-operator.test.ts`, new cases beside the `/api/prompt-role` case: a live-server
`POST /api/prompt` with `{ text, defer: "90m" }` answers 200 and the director queue's newest
prompt record (`queuedRolePromptEntries(root, DIRECTOR_ROLE)` or a raw read of
`.tumwater/inbox/<stamp>.md`) carries a `notBeforeMs` in the future, roughly now + 90m; a
`POST /api/prompt-role` with `{ role: "feature", text, defer: "1h30m" }` does the same for that
role's queue and still returns the wake message. `defer: "soon"`, `defer: "30m1h"`, and
`defer: 30` answer 400 matching `/duration like 45s, 90m, 1h30m, or 2d/` and queue no file;
`defer: "91d"` answers 400 matching `/capped at 90d/`; an absent `defer` queues the same
marker-less prompt as today (the existing cases stay green, and
`src/inbox/prompt-not-before.ts`'s `notBeforeMs()` reads `null` for it).
- `test/gui-client-composer.test.ts`: the submit test sets `promptdefer` and asserts both POST
bodies (`/api/prompt` and `/api/prompt-role`) carry the `defer` key unchanged, the flash names
`delivers in`, and the field clears on success but survives a rejected send; a string assertion
on `GUI_CLIENT_COMPOSER_JS` pins the `promptdefer` read and the `defer` key; the fake-DOM helper
gains the `promptdefer` element so the existing composer cases keep running.
- `test/cli-args.test.ts`'s `parseDurationFlag`/`durationLabel` cases stay green unchanged,
pinning the export as behavior-preserving.
- `docs/how-it-works.md` names the composer's defer control and the `tumwater prompt --at`
grammar it shares.
- `npm run test` is green.

### Show a loop's pending change in the TUI transcript pane, matching `tumwater diff --role <id>` (planned 2026-10-11 by plan; sibling of the landed CLI `tumwater diff --role <id>` and the landed dashboard loop drawer's "Pending change" section (`gui-client-drawer.ts`'s `drawerChangeHtml`); the TUI's Pending pane (`collectFleetChanges`/`renderFleetChange`) says which loops hold work but never the per-loop patch, so an operator must drop to the CLI or the browser drawer to read one; independent of the waiting TUI Queued pane, dashboard queued-prompt edit, and dashboard defer plans in behavior — it extends the transcript pane's `Ctrl+N` inspect cycle and the `src/change` collectors, touching no `src/inbox` or `src/gui` file — though it shares `tui-keys.ts`/`tui-frame.ts`/`tui.tsx`/`tui-pane.ts` with the Queued pane plan, so a landing conflict is possible and the resolver handles it; done 2026-10-11 by feature)

**Goal.** `tumwater diff --role <id>` prints one loop's unlanded work — the branch, the commits
ahead of main, the ahead-of-main patch, the dirty files, and the uncommitted patch — and the
dashboard's loop drawer shows the same collector's view. The TUI can reach neither: its Pending
pane lists which loops hold work (`renderFleetChange`), and its `Ctrl+N` inspect mode on a
transcript shows only the notebook and next tick prompt. Add the per-role change to that inspect
mode, rendering the CLI's own `renderRoleChange` output from the same `collectRoleChange` view,
so the terminal, the CLI, and the drawer cannot drift on the header, the commit lines, or the
patch caps.

**Approach.**
1. `src/ui/tui/tui-keys.ts`:
   - Extend the `src/change` imports beside the existing `collectFleetChanges`/`FleetChangeView`
     and `renderFleetChange`: add `collectRoleChange, type RoleChangeView` from
     `../../change/change-data.js` and `renderRoleChange` from `../../change/change-render.js`.
   - Add `collectChange?(root: string, role: string): Promise<RoleChangeView>` to `TuiKeysDeps`
     (doc: the transcript Change mode's async collector, production uses change-data's
     `collectRoleChange`, injectable so tests resolve a fixed view without git plumbing), and in
     the factory body `const collectChange = deps.collectChange ?? collectRoleChange;`.
   - `TuiKeysState` gains `changeMode: boolean` and `changeCache: string | null`, with doc
     comments paralleling `noteMode`/`noteCache`: `changeMode` is true only on a transcript view
     whose pane shows the loop's unlanded change, and `changeCache` is `renderRoleChange`'s text,
     null until the collector resolves. Add the matching locals `let changeMode = false; let changeCache: string | null = null;` beside `noteMode`/`noteCache`.
   - Extend the `Ctrl+N` branch (same guards: a transcript view, out of budget/role-prompt modes)
     from a toggle into a three-state cycle, transcript → notebook → change → transcript:
     - `changeMode` → `changeMode = false; changeCache = null;` (back to the transcript);
     - else `noteMode` → `noteMode = false; noteCache = null; changeMode = true; changeCache = null;`
       then kick off the collector fire-and-forget, mirroring the Pending pane's async arm: capture
       `const target = role;` and `void collectChange(root, target).then((change) => { if (!changeMode || roleIds[view - 1] !== target) return; changeCache = renderRoleChange(change); deps.requestRender(); }, (err: unknown) => { if (!changeMode || roleIds[view - 1] !== target) return; flashError(err); deps.requestRender(); });`;
     - else the notebook arm as today (`noteCache = roleInspectMarkdown(root, role); noteMode = true;`).
     `paneScroll = 0` on every transition, as today.
   - In the `Ctrl+T` branch, reset `changeMode = false; changeCache = null;` beside the notebook
     reset, so a cycle away drops the snapshot.
   - The `page !== null && noteMode` scroll branch becomes `page !== null && (noteMode || changeMode)`,
     windowing `noteMode ? (noteCache ?? "") : (changeCache ?? "")`.
   - `state()` returns the new `changeMode` and `changeCache`.
2. `src/ui/tui/tui-frame.ts`: `TuiView`'s transcript variant gains `change: boolean` beside
   `note`; `tabStrip`'s transcript label becomes
   `${view.note ? "Notebook" : view.change ? "Change" : "Transcript"}: ${view.role} (${view.index}/${view.count})`;
   `hintLine`'s transcript `Ctrl+N` word becomes
   `view.note ? "change" : view.change ? "transcript" : "notebook"`.
3. `src/ui/tui/tui.tsx`: the transcript `pane` object gains `change: s.changeMode`.
4. `src/ui/tui/tui-pane.ts`: `TuiPaneState` gains `changeCache: string | null` (its `noteCache`
   doc retargeted to "the notebook or change view's rendered text"); the transcript branch gains,
   after the `pane.note` case, an `if (pane.change)` case that windows `state.changeCache` through
   `entryBodyWindow` exactly like notebook mode (`toneLine` with `l.startsWith("#")` bold) and
   returns `emptyNote: "(loading pending change…)"` while the cache is null.
5. `docs/how-it-works.md`: the TUI bullet naming the `Ctrl+N` notebook toggle adds the Change step
   — the viewed loop's unlanded work (branch, commits, patch, dirty files), matching
   `tumwater diff --role <id>` and the dashboard drawer's Pending change section.

**Files touched.** `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`,
`src/ui/tui/tui-pane.ts`, `docs/how-it-works.md`, `test/tui-frame.test.ts`,
`test/tui-keys.test.ts`, `test/tui-notebook.test.ts`, `test/tui-history.test.ts`,
`test/tui-backlog.test.ts`.

**Acceptance criteria.**
- `test/tui-frame.test.ts`: every existing transcript literal gains `change: false` (the field is
  required); a `change: true` case tab-strips `[Change: qa (3/14)]` and hints `Ctrl+N transcript`,
  the `note: false` case stays `notebook`, and the `note: true` case names `change` — the
  notebook's next step in the cycle.
- `test/tui-keys.test.ts`, new case with an injected `collectChange` resolving a fixed
  `RoleChangeView` (e.g. `state: "ready"`, two commits, one dirty file): on a transcript view the
  first `Ctrl+N` sets `noteMode` true, the second sets `changeMode` true with `changeCache` null
  (the loading state), resolving the promise sets `changeCache` to `renderRoleChange(view)` and
  repaints, and the third `Ctrl+N` returns to the transcript with both caches null. `Ctrl+T` while
  in change mode clears it, and a collector resolution after a cycle away does not write the cache.
- `test/tui-notebook.test.ts`: the toggle test now walks transcript → notebook → change →
  transcript, asserting the `Change: clean` tab label on the middle press (with the real fixture's
  collector degrading to its `no worktree`/`no pending change` line, so the label is what is
  pinned), and that a `Ctrl+T` away and back lands on the live transcript.
- `test/tui-history.test.ts`: a `paneBody` case for a transcript pane with `change: true`
  windows `state.changeCache` and returns `(loading pending change…)` when it is null (the
  paneBody cases' established home; its own and `test/tui-backlog.test.ts`'s state literals gain
  the required `changeCache`).
- `docs/how-it-works.md` names the Change step and `tumwater diff --role <id>`.
- `npm run test` is green.

### Edit a queued prompt from the dashboard Queued tab (planned 2026-10-11 by plan; part 2/2 of "Edit a queued prompt from the dashboard Queued tab" — the browser affordance over part 1/2's `GET /api/prompt-text` and `POST /api/prompt-edit`, requires part 1/2 landed; independent of the waiting TUI Pending land-queue, TUI History grep, and dashboard Settings Clear plans — GUI client only, no `src/ui/tui`, `src/inbox`, or `src/gui` file; done 2026-10-11 by feature)

**Goal.** The dashboard's Queued tab lists every queued prompt with a Cancel button, but
correcting a typo means cancel and re-queue; `tumwater prompt --edit` has no browser surface even
though part 1/2 serves the body and the write. Add an inline editor: an Edit button per queued
row loads the prompt's body into a textarea in place, and Save replaces it through
`/api/prompt-edit`.

**Approach.**
1. `src/ui/gui/gui-client-fleet.ts`, the `backlog` region:
   - Add state beside `backlogTab`: `let backlogStatus = null` (the payload the edit helpers
     repaint from), `let queuedEdit = null` (`{ role, file, text } | null`), and
     `let queuedEditPainted = false`.
   - `renderBacklog(d)`: set `backlogStatus = d` first; then
     `if (queuedEdit && queuedEditPainted) return;` so the standing 1s poll cannot repaint over
     the textarea the operator is typing in.
   - The queued row map: each item gets, after the Cancel button,
     `<button type='button' class='btn btn-sm rowaction' data-action='promptedit' data-file='…'
     data-role='…'>Edit</button>`; when the item matches `queuedEdit`
     (`q.file === queuedEdit.file && q.role === queuedEdit.role`), render instead a
     `<div class='list-item'>` holding `<textarea id='queuedit' class='…'>` + `esc(queuedEdit.text)`
     + `</textarea>` and Save/Cancel buttons (`data-action='prompteditsave'`/`'prompteditcancel'`,
     each carrying the same `data-file`/`data-role`). Set `queuedEditPainted = true` before
     `paintPanel` when the editor was rendered.
   - Add `function beginQueuedEdit(role, file, text)`: `backlogTab = "queued";
     queuedEdit = { role, file, text }; queuedEditPainted = false; renderBacklog(backlogStatus)`.
   - Add `function endQueuedEdit()`: `queuedEdit = null; queuedEditPainted = false;
     renderBacklog(backlogStatus)`.
   - `setBacklogTab(tab)`: before `renderBacklog(lastStatus)`, clear `queuedEdit` and
     `queuedEditPainted`, so switching tabs abandons an open editor.
2. The delegated `$("backlog")` click handler (below the region) gains three arms before the
   `.backloglink` arm: `button.rowaction[data-action='promptedit']` →
   `await getJson("/api/prompt-text?role=" + encodeURIComponent(role) + "&file=" +
   encodeURIComponent(file))`; a `{ status: "gone" }` answer flashes `"No longer queued — …
   already took it"` and refreshes, otherwise `beginQueuedEdit(role, file, d.text || "")`; a thrown
   fetch flashes the `error:` pattern. `[data-action='prompteditsave']` → read `$("queuedit")`'s
   trimmed `value` (flash and stop when empty), `await postAction("/api/prompt-edit", { role,
   file, text }, …)` with the `edited`/`gone` flash wording the cancel arm uses, then
   `endQueuedEdit()`. `[data-action='prompteditcancel']` → `endQueuedEdit()`. `$` and `getJson` are
   already in scope; `endQueuedEdit`/`beginQueuedEdit` are hoisted from the region.
3. `docs/how-it-works.md`: the Operator notes sentence naming the Queued tab adds that each
   queued prompt can be edited in place (Edit loads its body, Save replaces it through the same
   path `tumwater prompt --edit` uses), beside the existing age sentence.

**Files touched.** `src/ui/gui/gui-client-fleet.ts`, `test/gui-client-fleet.test.ts`,
`docs/how-it-works.md`.

**Acceptance criteria.**
- `test/gui-client-fleet.test.ts`: the queued rows now emit one `data-action='promptedit'` Edit
  button per prompt beside the cancel buttons, with the queue-file address and role (the existing
  cancel assertions stay green). `beginQueuedEdit("qa", "q.md", "new body")` paints the queued tab
  with a `<textarea id='queuedit'>` holding `new body` and Save/Cancel buttons carrying
  `data-file='q.md'`/`data-role='qa'`, and a following `renderBacklog(status)` writes no second
  paint (the poll cannot clobber the editor). `endQueuedEdit()` repaints the plain list (no
  textarea, Edit and Cancel buttons back). `setBacklogTab` while editing discards the editor and
  paints the newly selected tab.
- A string assertion on `GUI_CLIENT_FLEET_JS` pins the delegated handler's edit arms: the
  `promptedit`, `prompteditsave`, and `prompteditcancel` selectors, the `/api/prompt-text?role=`
  fetch, and the `/api/prompt-edit` post.
- `docs/how-it-works.md` describes the Queued tab's Edit action and names `tumwater prompt --edit`
  as the path it shares.
- `npm run test` is green.

### List every loop's queued prompts in a TUI Queued pane, matching `tumwater prompt --list` (planned 2026-10-11 by plan; sibling of the landed TUI Pending pane (`tumwater queue`), the landed dashboard Queued tab (`prompt --cancel`), and the waiting dashboard queued-prompt edit series (parts 1/2 and 2/2); completes `tumwater prompt --list`'s read surface on the TUI, which today shows only the director's numbered previews above every pane (`tui.tsx`'s `snap.inboxPrompts`) and each role's `p:N` count marker (`status-render.ts`'s `roleQueued`), never the role queues' contents or a deferred prompt's countdown; read-only, so it needs no server, mutation, or cancellation; independent of the waiting TUI History grep plan in behavior — it touches `tui-keys.ts`/`tui-frame.ts`/`tui.tsx` too, but its own Queued branch rather than the History branches, so a landing conflict is possible and the resolver handles it; it shares `src/inbox/inbox.ts` with the waiting dashboard queued-edit part 1/2 only at the read seam, which edits `inbox-edit.ts`; done 2026-10-11 by feature)

**Goal.** `tumwater prompt --list` prints every queued prompt grouped by loop (director first, then
catalog order), each numbered from 1 with its full text and a `(queued <age> ago)` suffix — or a
`(delivers in <duration>)` countdown when the prompt carries a not-before marker — while
`tumwater prompt --cancel <n>` consumes that same per-loop numbering. The TUI has no pane showing
that list. Add a Queued pane after Pending that renders the CLI's list from the CLI's own row
builder, so the two surfaces cannot drift on order, numbering, or the age/countdown wording.

**Approach.**
1. `src/inbox/inbox.ts`: move the list-shaping pieces out of `prompt-commands.ts` so the CLI and
the TUI read one queue list (import `knownRoleIdsCached` from `../config/config.js` — config
imports no inbox module, so no cycle — and `humanSeconds`/`secondsSince`/`secondsUntil` from
`../text/datetime.js`):
   - `export function listWideScope(root: string): string[]` — the moved one-liner
     `[DIRECTOR_ROLE, ...knownRoleIdsCached(root).filter((r) => r !== DIRECTOR_ROLE)]`.
   - `export interface QueuedListRow { role: string; position: number; text: string; queuedAtMs: number | null; notBeforeMs: number | null }`.
   - `export function queuedListRows(root: string, role: string | null, validIds: string[]): QueuedListRow[]` —
     the moved `promptListPayload` body (director records first when `role` is null, then
     `validIds`), stripping the marker from each text through `stripNotBeforeMarker` exactly as
     today.
   - `export function queuedAgeSuffix(queuedAtMs: number | null, notBeforeMs: number | null, now: number): string` —
     moved verbatim from `prompt-commands.ts`, doc comment kept.
   - `export function renderQueuedList(rows: readonly QueuedListRow[], now: number): string` —
     the moved section loop: group consecutive rows by role, one `<role>:` section per loop
     holding `"<position>. <text><queuedAgeSuffix>"` lines, sections joined by `\n`; the CLI's
     `say(sections.join("\n"))` output is byte-identical.
   Keep each moved doc comment, retargeting “the CLI's --list” to name both surfaces.
2. `src/inbox/prompt-commands.ts`: delete the moved locals (`promptListPayload`,
`queuedAgeSuffix`, `listWideScope`) and the now-unused `humanSeconds`/`secondsSince`/
`secondsUntil`/`knownRoleIdsCached` imports; import `listWideScope`, `queuedListRows`,
`renderQueuedList` from `./inbox.js`. The `--json` arm keeps
`sayJson({ prompts: queuedListRows(root, role, validIds as string[]) })`; the prose arm keeps its
`prompts.length === 0` guard, then `say(renderQueuedList(prompts, Date.now()))`.
3. `src/ui/tui/tui-frame.ts`: `TuiView` gains `| { kind: "queued" }`; `tabStrip`'s `tabs` gains
`["queued", "Queued"]` after `["pending", "Pending"]`; `hintLine` gains a `queued` branch with
the pending branch's keys (`Enter`/`↑↓`/`PgUp PgDn`/`Ctrl+T`/`Ctrl+D`).
4. `src/ui/tui/tui-keys.ts`: import `listWideScope`, `queuedListRows`, `renderQueuedList` from
`../../inbox/inbox.js`; in the Ctrl+T handler change the cycle to
`(view + 1) % (roleIds.length + 7)` and add, beside the Pending branch inside
`if (!refreshPaneCache("all"))`, `else if (view === roleIds.length + 6) paneCache =
renderQueuedList(queuedListRows(root, null, listWideScope(root)), now());` (the factory's
injected `now` clock, so a test pins the suffix); the `syncSnapshot` clamp becomes
`Math.min(view, roleIds.length + 6)`; update the `view` comments.
5. `src/ui/tui/tui.tsx`: the pane selection gains
`: view === roleIds.length + 6 ? { kind: "queued" }` before the activity fallback.
6. `src/ui/tui/tui-pane.ts`: add a `queued` branch returning `paneCache` windowed through
`entryBodyWindow` exactly like the `history`/`pending` branches, with
`emptyNote: "(no queued prompts)"`; extend the `paneBody` doc's kind list.
7. `docs/how-it-works.md`: the TUI bullet lists the Queued pane after Pending and names
`tumwater prompt --list` as the CLI view it matches.

**Files touched.** `src/inbox/inbox.ts`, `src/inbox/prompt-commands.ts`,
`src/ui/tui/tui-frame.ts`, `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui.tsx`,
`src/ui/tui/tui-pane.ts`, `docs/how-it-works.md`, `test/prompt-commands.test.ts`,
`test/tui-frame.test.ts`, `test/tui-keys.test.ts`, `test/tui-history.test.ts`,
`test/tui.test.ts`, `test/tui-notebook.test.ts`.

**Acceptance criteria.**
- `test/prompt-commands.test.ts`: the existing `prompt --list` prose and `--json` cases stay green
  against the extracted `queuedListRows`/`renderQueuedList` (same sections, numbering, and
  suffix). A new case seeds one director prompt and two role prompts and asserts
  `renderQueuedList(queuedListRows(root, null, listWideScope(root)), now)` yields the director
  section first then the role's, each numbered from 1, and a deferred prompt's line carries
  `(delivers in ` from its future `notBeforeMs` rather than an age.
- `test/tui-keys.test.ts`: the cycle case now sees Pending at `roleIds.length + 5`, a further
  Ctrl+T lands on Queued at `roleIds.length + 6`, and the next wraps to Activity; with a director
  and a role queue file seeded, entering Queued sets `state().paneCache` to
  `renderQueuedList(queuedListRows(root, null, listWideScope(root)), <fixed now>)`; leaving Queued
  drops it to null.
- `test/tui-frame.test.ts`: every `tabStrip` expectation gains `Queued` after `Pending` (including
  the narrow-width case staying within its width), a `hintLine({ kind: "queued" }, …)` case
  matches its keys, and the Ctrl+D loop includes `{ kind: "queued" }`.
- `test/tui-history.test.ts` (the file the paneBody history/pending cases actually live in, not
  `test/tui.test.ts` as first planned): a `paneBody({ kind: "queued" }, …)` case windows the cached
  list and returns the `(no queued prompts)` note when the cache is null.
- `test/tui.test.ts` and `test/tui-notebook.test.ts`: the full-TUI Ctrl+T cycle tests grew one
  Queued step between Pending and the wrap back to Activity.
- `docs/how-it-works.md` names the Queued pane and `tumwater prompt --list`.
- `npm run test` is green.

### List every loop's queued prompts in a TUI Queued pane, matching `tumwater prompt --list` (planned 2026-10-11 by plan; sibling of the landed TUI Pending pane (`tumwater queue`), the landed dashboard Queued tab (`prompt --cancel`), and the waiting dashboard queued-prompt edit series (parts 1/2 and 2/2); completes `tumwater prompt --list`'s read surface on the TUI, which today shows only the director's numbered previews above every pane (`tui.tsx`'s `snap.inboxPrompts`) and each role's `p:N` count marker (`status-render.ts`'s `roleQueued`), never the role queues' contents or a deferred prompt's countdown; read-only, so it needs no server, mutation, or cancellation; independent of the waiting TUI History grep plan in behavior — it touches `tui-keys.ts`/`tui-frame.ts`/`tui.tsx` too, but its own Queued branch rather than the History branches, so a landing conflict is possible and the resolver handles it; it shares `src/inbox/inbox.ts` with the waiting dashboard queued-edit part 1/2 only at the read seam, which edits `inbox-edit.ts`; done 2026-10-11 by feature)

**Goal.** `tumwater prompt --list` prints every queued prompt grouped by loop (director first, then
catalog order), each numbered from 1 with its full text and a `(queued <age> ago)` suffix — or a
`(delivers in <duration>)` countdown when the prompt carries a not-before marker — while
`tumwater prompt --cancel <n>` consumes that same per-loop numbering. The TUI has no pane showing
that list. Add a Queued pane after Pending that renders the CLI's list from the CLI's own row
builder, so the two surfaces cannot drift on order, numbering, or the age/countdown wording.

**Approach.**
1. `src/inbox/inbox.ts`: move the list-shaping pieces out of `prompt-commands.ts` so the CLI and
the TUI read one queue list (import `knownRoleIdsCached` from `../config/config.js` — config
imports no inbox module, so no cycle — and `humanSeconds`/`secondsSince`/`secondsUntil` from
`../text/datetime.js`):
   - `export function listWideScope(root: string): string[]` — the moved one-liner
     `[DIRECTOR_ROLE, ...knownRoleIdsCached(root).filter((r) => r !== DIRECTOR_ROLE)]`.
   - `interface QueuedListRow { role: string; position: number; text: string; queuedAtMs: number | null; notBeforeMs: number | null }`.
   - `export function queuedListRows(root: string, role: string | null, validIds: string[]): QueuedListRow[]` —
     the moved `promptListPayload` body (director records first when `role` is null, then
     `validIds`), stripping the marker from each text through `stripNotBeforeMarker` exactly as
     today.
   - `queuedAgeSuffix(queuedAtMs: number | null, notBeforeMs: number | null, now: number): string` —
     moved verbatim from `prompt-commands.ts`, doc comment kept. (The row type and this suffix
     are file-private: the tests' `exports.test.ts` flag an `export` with no user outside its
     own file, and both surfaces consume the suffix only through `renderQueuedList`.)
   - `export function renderQueuedList(rows: readonly QueuedListRow[], now: number): string` —
     the moved section loop: group consecutive rows by role, one `<role>:` section per loop
     holding `"<position>. <text><queuedAgeSuffix>"` lines, sections joined by `\n`; the CLI's
     `say(sections.join("\n"))` output is byte-identical.
   Keep each moved doc comment, retargeting “the CLI's --list” to name both surfaces.
2. `src/inbox/prompt-commands.ts`: delete the moved locals (`promptListPayload`,
`queuedAgeSuffix`, `listWideScope`) and the now-unused `humanSeconds`/`secondsSince`/
`secondsUntil`/`knownRoleIdsCached` imports; import `listWideScope`, `queuedListRows`,
`renderQueuedList` from `./inbox.js`. The `--json` arm keeps
`sayJson({ prompts: queuedListRows(root, role, validIds as string[]) })`; the prose arm keeps its
`prompts.length === 0` guard, then `say(renderQueuedList(prompts, Date.now()))`.
3. `src/ui/tui/tui-frame.ts`: `TuiView` gains `| { kind: "queued" }`; `tabStrip`'s `tabs` gains
`["queued", "Queued"]` after `["pending", "Pending"]`; `hintLine` gains a `queued` branch with
the pending branch's keys (`Enter`/`↑↓`/`PgUp PgDn`/`Ctrl+T`/`Ctrl+D`).
4. `src/ui/tui/tui-keys.ts`: import `listWideScope`, `queuedListRows`, `renderQueuedList` from
`../../inbox/inbox.js`; in the Ctrl+T handler change the cycle to
`(view + 1) % (roleIds.length + 7)` and add, beside the Pending branch inside
`if (!refreshPaneCache("all"))`, `else if (view === roleIds.length + 6) paneCache =
renderQueuedList(queuedListRows(root, null, listWideScope(root)), now());` (the factory's
injected `now` clock, so a test pins the suffix); the `syncSnapshot` clamp becomes
`Math.min(view, roleIds.length + 6)`; update the `view` comments.
5. `src/ui/tui/tui.tsx`: the pane selection gains
`: view === roleIds.length + 6 ? { kind: "queued" }` before the activity fallback.
6. `src/ui/tui/tui-pane.ts`: add a `queued` branch returning `paneCache` windowed through
`entryBodyWindow` exactly like the `history`/`pending` branches, with
`emptyNote: "(no queued prompts)"`; extend the `paneBody` doc's kind list.
7. `docs/how-it-works.md`: the TUI bullet lists the Queued pane after Pending and names
`tumwater prompt --list` as the CLI view it matches.

**Files touched.** `src/inbox/inbox.ts`, `src/inbox/prompt-commands.ts`,
`src/ui/tui/tui-frame.ts`, `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui.tsx`,
`src/ui/tui/tui-pane.ts`, `docs/how-it-works.md`, `test/tui-frame.test.ts`,
`test/tui-keys.test.ts`, `test/tui.test.ts`, `test/tui-notebook.test.ts`,
`test/tui-history.test.ts` (the `paneBody` cases' home, corrected from the planned
`test/tui.test.ts` in the landing).

**Acceptance criteria.**
- `test/prompt-commands.test.ts`: the existing `prompt --list` prose and `--json` cases stay green
  against the extracted `queuedListRows`/`renderQueuedList` (same sections, numbering, and
  suffix). A new case seeds one director prompt and two role prompts and asserts
  `renderQueuedList(queuedListRows(root, null, listWideScope(root)), now)` yields the director
  section first then the role's, each numbered from 1, and a deferred prompt's line carries
  `(delivers in ` from its future `notBeforeMs` rather than an age.
- `test/tui-keys.test.ts`: the cycle case now sees Pending at `roleIds.length + 5`, a further
  Ctrl+T lands on Queued at `roleIds.length + 6`, and the next wraps to Activity; with a director
  and a role queue file seeded, entering Queued sets `state().paneCache` to
  `renderQueuedList(queuedListRows(root, null, listWideScope(root)), <fixed now>)`; leaving Queued
  drops it to null.
- `test/tui-frame.test.ts`: every `tabStrip` expectation gains `Queued` after `Pending` (including
  the narrow-width case staying within its width), a `hintLine({ kind: "queued" }, …)` case
  matches its keys, and the Ctrl+D loop includes `{ kind: "queued" }`.
- `test/tui-history.test.ts` (beside the existing History/Pending `paneBody` cases): a
  `paneBody({ kind: "queued" }, …)` case windows the cached list and returns
  the `(no queued prompts)` note when the cache is null.
- `docs/how-it-works.md` names the Queued pane and `tumwater prompt --list`.
- `npm run test` is green.

### Read and edit a queued prompt by its queue file behind the dashboard API (planned 2026-10-11 by plan; part 1/2 of "Edit a queued prompt from the dashboard Queued tab" — the server seam and endpoints its client half consumes; sibling part 2/2 requires this landed; the file-addressed twin of the landed CLI `tumwater prompt --edit` and the landed file-addressed `POST /api/prompt-cancel`; independent of the waiting TUI Pending land-queue, TUI History grep, and dashboard Settings Clear plans in code — inbox/gui only, no `src/ui/tui` or `src/ui/gui` file — though it shares `src/gui/gui-endpoint-commands.ts` and `src/gui/gui-server.ts` with the Settings Clear plan, so a landing conflict is possible and the resolver handles it; done 2026-10-11 by feature)

**Goal.** `tumwater prompt --edit <n>` rewrites a queued prompt's text in place and carries its
attachments, and the dashboard's Queued tab can cancel a prompt, but the browser has no way to
edit one: `/api/prompt-cancel` addresses a prompt by its queue file while `editRolePrompt`
addresses it by list position, and no endpoint exposes the queued body. Add a file-addressed
read and edit to the API — `GET /api/prompt-text` returns a prompt's editable body and `POST
/api/prompt-edit` replaces it through the same `editRolePrompt` machinery the CLI uses.

**Approach.**
1. `src/inbox/inbox-attachments.ts`: add `export function stripImageReferenceLines(text: string): string`
   beside `imageReferencePaths` — drop every line whose trimmed form matches the module's own
   `IMAGE_REF_LINE` and trim trailing blank lines, documented as the reader `imageReferenceLines`
   needs (the reference block is plumbing, never shown in an editor).
2. `src/inbox/inbox-edit.ts`:
   - Extract the body of `editRolePrompt` after it resolves `file` into a private
     `editPromptAtFile(root: string, role: string, file: string, newText: string, images?: PromptImageInput[]): EditOutcome`
     (unchanged behavior: trim, length check, read, gone-on-ENOENT, carried deferral, carried and
     appended image references, atomic write, `prompt_edited` event). `editRolePrompt` becomes
     `queuedFileAtPosition` → `editPromptAtFile`.
   - Add `export function editQueuedFile(root, role, name, newText, images?): EditOutcome` —
     `queueFileNameProblem(name)` (imported from `./inbox-cancel.js`) throws its message, then
     `editPromptAtFile(root, role, path.join(roleInboxDir(root, role), name), newText, images)`.
     Import `path` from `node:path` and `roleInboxDir` from `../paths.js`.
   - Add `export function readQueuedPromptBody(root, role, name): string | null` — the same name
     guard (throw), `readTextIfExists(path.join(roleInboxDir(root, role), name))`, `null` when the
     file is gone, else `stripImageReferenceLines(stripNotBeforeMarker(text)).trimEnd()`. Reading
     one file directly keeps the dashboard's lazy fetch off the per-poll path.
3. `src/gui/gui-endpoints.ts`: add `export function handlePromptText(q: URLSearchParams, res, root)`
   — `const roleParam = q.get("role")`; when it is non-null and `rejectBadRole(root, res, roleParam)`
   returns, stop; `role = roleParam ?? DIRECTOR_ROLE`; `queueFileNameProblem(q.get("file"))` → 400
   `{ error }`; `readQueuedPromptBody` → null `{ ok: true, status: "gone" }`, else
   `{ ok: true, text }`. Imports: `readQueuedPromptBody` from `../inbox/inbox-edit.js`,
   `queueFileNameProblem` from `../inbox/inbox-cancel.js`, `DIRECTOR_ROLE`, `rejectBadRole`. Update
   the module doc's endpoint list.
4. `src/gui/gui-endpoint-commands.ts`: add `export async function handlePromptEdit(req, res, root)`
   beside `handlePromptCancel` — `readPostBody(req, res, '{"role": "qa", "file": "<stamp>.md", "text": "..."}')`;
   role optional exactly like cancel (`body.role !== undefined && rejectBadRole(...)` → 400, default
   `DIRECTOR_ROLE`); `queueFileNameProblem(body.file)` → 400; `checkedPromptFields(res, body, role)`
   → 400 on a null return (the text and images validators `/api/prompt` and `/api/prompt-role`
   share); then `editQueuedFile(root, role, body.file as string, fields.text, fields.images)` in a
   try/catch, answering its thrown message 400 (the same mapping the CLI's `prompt --edit` wrapper
   applies to the combined body-plus-image cap; a filesystem failure reads as 400 like
   `handleConfigSet`'s failed write); `edited` → 200 `{ ok: true, status: "edited", oldText,
   newText }`, `gone` → 200 `{ ok: true, status: "gone" }`. Import `editQueuedFile` from
   `../inbox/inbox-edit.js`; update the module doc's POST list.
5. `src/gui/gui-server.ts`: import `handlePromptText` from `./gui-endpoints.js` and
   `handlePromptEdit` from `./gui-endpoint-commands.js`; add `"GET /api/prompt-text": (_req, res,
   target) => handlePromptText(target.searchParams, res, root)` beside `"GET /api/transcript"` and
   `"POST /api/prompt-edit": (req, res) => handlePromptEdit(req, res, root)` beside
   `"POST /api/prompt-cancel"`.

**Files touched.** `src/inbox/inbox-attachments.ts`, `src/inbox/inbox-edit.ts`,
`src/gui/gui-endpoints.ts`, `src/gui/gui-endpoint-commands.ts`, `src/gui/gui-server.ts`,
`test/inbox-edit.test.ts`, `test/gui-endpoints.test.ts`.

**Acceptance criteria.**
- `test/inbox-edit.test.ts`: `editQueuedFile(root, "qa", "q.md", "new text")` rewrites the named
  queue file in place (same basename, new body) and returns `{ status: "edited", oldText, newText }`;
  a name failing `queueFileNameProblem` (`"../x.md"`, `"q.txt"`) throws and touches nothing; a
  missing file returns `{ status: "gone" }`; an attached `q.md` keeps its `[image attached: …]`
  line and image file through the file-addressed entry point. `readQueuedPromptBody` returns the
  body without the not-before marker and without the `[image attached: …]` lines (a marked,
  attached file as the fixture), `null` for a vanished file, and throws on a bad name.
- `test/gui-endpoints.test.ts`: a `servePromptText(root, "?role=qa&file=q.md")` helper (the
  `handleTranscript`-style GET helper) answers 200 `{ ok: true, text: "…" }` for a seeded queue
  file and `{ ok: true, status: "gone" }` for an absent one; a bad or missing `file` is 400 naming
  the guard's message; a `role` the repo does not know is 400 through `rejectBadRole`. A
  `servePromptEdit(root, { role: "qa", file: "q.md", text: "new" })` helper (the `fakeReq` POST
  helper) answers 200 `{ ok: true, status: "edited", oldText, newText: "new" }`, and the file on
  disk holds the new body while a sibling queue file is intact; a bad file name and an over-cap
  text are 400; an absent file answers `{ ok: true, status: "gone" }`; a missing `file` is 400.
- `npm run test` is green.


### Search the TUI History pane with `tumwater history --grep`'s rule (planned 2026-10-11 by plan; sibling of the landed `tumwater history --grep`, the landed dashboard History search, and the landed TUI History `Ctrl+S`/`Ctrl+O`/`Ctrl+G` filters; completes the last `history` filter without a TUI surface; independent of the waiting TUI Pending land-queue plan — it shares `src/ui/tui/tui-keys.ts` and `tui-frame.ts` but edits the History pane's branches, the prompt-line modes, and the history view shape, not the Pending branch, so a landing conflict is possible and the resolver handles it; done 2026-10-11 by feature)

**Goal.** The History pane filters by trailing window (`Ctrl+S`), outcome class (`Ctrl+O`), and exact loop (`Ctrl+G`), but a free-text search has no TUI surface: `tumwater history --grep <text>` and the dashboard's History search field both filter the rows through `history-data.ts`'s `tickRowGrepHaystack` case-insensitive substring rule. Add that search to the TUI, reading the same haystack so the three surfaces cannot disagree.

**Approach.**
1. `src/ui/tui/tui-keys.ts`: import `tickRowGrepHaystack` from `../../history/history-data.js`.
   - `historyPaneCache` gains a fifth parameter `grep: string | null`. After the role/window read, apply the outcome class as today, then `if (grep !== null) filtered = filtered.filter((r) => tickRowGrepHaystack(r).toLowerCase().includes(grep.toLowerCase()))`. Capture `const afterGrep = <rows after the result filter and before grep>` so the empty-body wording can tell which filter emptied the set. Add `search: <grep>` to the `header` array after the existing role/window/result labels. Empty body: mirror `tumwater history`'s precedence (`src/history/history.ts`): name the result class when it emptied a set grep admitted (`resultClass !== null && afterGrep > 0` → `no ticks with result "<class>"`), else name the pattern when one is set (`no ticks matching "<grep>"`), else return `""` (the pane's own no-ticks note).
   - Pass `historyGrep` at every `historyPaneCache` call site: the `Ctrl+T` History entry, the `Ctrl+G`, `Ctrl+S`, and `Ctrl+O` handlers, and `syncSnapshot`'s stale-scope recompute.
   - New session state beside `historyResult`/`historyRole`: `let historyGrep: string | null = null` (the applied filter) and `let searchMode = false` with `searchSavedInput`/`searchSavedCursor` (its own saved-draft pair, exactly like the budget and role-prompt editors). Add `exitHistorySearch()` restoring `input`/`cursor` from the saved pair and clearing `searchMode`.
   - Add a branch before the arrow/return/`applyKey` tail, after the `Ctrl+T` branch: `if (!key.ctrl && str === "/" && !searchMode && !budgetMode && !rolePromptFor && view === roleIds.length + 4 && input === "")` → enter search: save the (empty) draft, set `searchMode = true`, prefill `input = historyGrep ?? ""`, `cursor = input.length`, flash `search ticks: Enter to filter, Esc to cancel`. `/` is the pager search key and this project already reserves `/` for a meta action (the dashboard composer's jump-to-composer hint); guarding on the empty line leaves a director draft untouched, and off History `/` still types into the prompt line.
   - `Enter` gains a `searchMode` arm first: `historyGrep = input.trim() === "" ? null : input.trim()`, `exitHistorySearch()`, recompute `paneCache = historyPaneCache(root, historyWindow, historyResult, historyRole, historyGrep)`, reset `paneScroll = 0`, flash `search: "<grep>"` or `search cleared`.
   - `Escape` gains a `searchMode` arm (cancel without applying, restore the draft). `Ctrl+T` calls `exitHistorySearch()` beside the budget/role exits (the applied `historyGrep` persists across view cycling, like `historyWindow`/`historyResult`). Guard the `Ctrl+G`/`Ctrl+S`/`Ctrl+O` handlers and the `Up`/`Down` prompt-history recall with `!searchMode`, mirroring how budget and role-prompt modes make them inert.
   - Expose `historyGrep: string | null` on `TuiKeysState` (interface and getter).
2. `src/ui/tui/tui-frame.ts`: the `TuiView` `history` variant gains `grep: string | null`; the history arm of `hintLine` adds `["/", view.grep ? `search: ${view.grep}` : "search"]`. `tabStrip` is unchanged (the pane's own `search:` header names the active pattern).
3. `src/ui/tui/tui.tsx`: the History pane construction passes `grep: s.historyGrep`.
4. `docs/how-it-works.md`: the TUI bullet's History sentences add the search — `/` on the History pane filters by the same `tickRowGrepHaystack` haystack `tumwater history --grep` and the dashboard search use, Enter applies and names the pattern, Esc cancels.

**Files touched.** `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`, `test/tui-keys.test.ts`, `test/tui-frame.test.ts`, `test/tui-history.test.ts`, `docs/how-it-works.md`.

**Acceptance criteria.**
- `test/tui-keys.test.ts`, a new case with seeded `tick_end` events whose rendered rows differ: cycle to History, press `/` with an empty line, type a substring, press Enter — `state().historyGrep` equals the trimmed text and `state().paneCache` holds only the matching rows; re-open `/` and submit an empty line — `historyGrep` is `null` and the full rows return. Esc during search leaves `historyGrep` unchanged and restores the pre-search prompt text. `/` off the History view, and on History with a non-empty line or in budget/role-prompt mode, does not enter search (it types into the prompt line or is ignored as today). `Ctrl+G`/`Ctrl+S`/`Ctrl+O` and `Up`/`Down` are inert while search holds the line.
- `test/tui-frame.test.ts`: a history view with `grep: "widget"` shows `search: widget` in `hintLine`, while `grep: null` shows `search`; the existing history hint/tab cases and the all-views `Ctrl+D` loop stay green (their history literals gain `grep: null`).
- `test/tui-history.test.ts`'s expectations are unchanged (`historyPaneText` still renders whatever rows it is handed); its two `TuiView` history literals gained `grep: null` for the new required field.
- `docs/how-it-works.md` describes the History search and names `tumwater history --grep` as the CLI rule it shares.
- `npm run test` is green.

### Clear a curated config key from the dashboard Settings view, matching `tumwater config unset` (planned 2026-10-11 by plan; sibling of the landed CLI `tumwater config unset <key>` and the landed dashboard Settings Save, which share `src/config/config-write.ts`'s `unsetConfigKey`/`setConfigKey`; the Settings view can set the curated keys but has no way to retract one, so an operator who set `notify` must drop to the CLI to remove it, and the README calls `unset` the inverse of `set`; independent of the waiting TUI Pending land-queue and TUI History grep plans in code — GUI/CLI only, no `src/ui/tui`, `src/history`, or `src/landing` file — though all three touch `docs/how-it-works.md`, so a doc landing conflict is possible and the resolver handles it; done 2026-10-11 by feature)

**Goal.** `tumwater config unset <key>` removes a value from tumwater.json so it reverts to its default or disappears from its map or section, and the dashboard's Settings view writes the same curated keys through Save — but it has no Clear affordance, so the dashboard can only add or overwrite keys, never retract one. Add POST `/api/config-unset` and a per-row Clear button, both going through the shared `unsetConfigKey` so the browser cannot drift from the CLI's rules.

**Approach.**
1. `src/gui/gui-endpoint-commands.ts`: add `handleConfigUnset(req, res, root)` mirroring `handleConfigSet` directly below it. Import `unsetConfigKey` from `../config/config-write.js` beside the existing `setConfigKey`. `readPostBody(req, res, '{"key": "model"}')`; gate `body.key` on `(EDITABLE_CONFIG_KEYS as readonly string[]).includes(key)` with the same 400 wording `handleConfigSet` uses (the `gotSuffix` convention for an absent key); call `unsetConfigKey(root, key)`; on `!result.ok` send 400 `{ error: \`${key}: ${result.error}\` }`; on success send 200 `{ ok: true, key, oldValue: result.oldValue }` (JSON omits `oldValue` when the file never held the key, so the client can tell a retraction from a no-op; a file value of `null` still serializes and is a real retraction).
2. `src/gui/gui-server.ts`: import `handleConfigUnset` from `./gui-endpoint-commands.js` and add the route `"POST /api/config-unset": (req, res) => handleConfigUnset(req, res, root)` next to `"POST /api/config-set"`.
3. `src/ui/gui/gui-client-settings.ts`: in `renderSettings`, after the Save button of each row, emit `<button type='button' class='btn btn-sm rowaction' data-action='unset'>Clear</button>`. Add `async function clearSetting(form)`: read `key = form.dataset.key`, `postJson("/api/config-unset", { key })`, then flash `"Unset " + key + " (was " + JSON.stringify(d.oldValue) + ")"` when `d.oldValue !== undefined`, else `"Nothing to unset for " + key + " — it was already the default"`; on success `await fetchSettings()` so the field repaints with the reverted resolved value (unsetting `maxDailyCostUsd`, for example, restores the default 50, not an empty field); on error flash the `"error: " + (err && err.message ? err.message : String(err))` pattern `saveSetting` uses. Update the module doc comment to name the unset half.
4. `src/ui/gui/gui-client-boot.ts`: beside the existing delegated `submit` listener for `form.settings-row`, add a delegated `click` listener that resolves `button[data-action='unset']` through `clickClosest`, walks to its `form.settings-row`, and calls `clearSetting(form)` — no per-row wiring, so the panel repaints freely.
5. `docs/how-it-works.md`: the Settings sentence (the one naming the inline Save buttons and `tumwater config set`) adds the Clear button and names `tumwater config unset` as the shared path, noting the field reverts to the key's default.

**Files touched.** `src/gui/gui-endpoint-commands.ts`, `src/gui/gui-server.ts`, `src/ui/gui/gui-client-settings.ts`, `src/ui/gui/gui-client-boot.ts`, `test/gui-endpoints.test.ts`, `test/gui-client-settings.test.ts`, `docs/how-it-works.md`.

**Acceptance criteria.**
- `test/gui-endpoints.test.ts`, a `serveConfigUnset` helper and new cases beside the config-set ones: with `{ model: "gpt-5", quietHours: "23:00-07:00" }` on disk, `handleConfigUnset(root, { key: "model" })` answers 200 `{ ok: true, key: "model", oldValue: "gpt-5" }`, the file on disk no longer holds `model`, and `quietHours` is intact; a key outside `EDITABLE_CONFIG_KEYS` (`customLoops`) and a body with no `key` are 400 with the same wording `handleConfigSet` uses; unsetting a key the file never held answers 200 with no `oldValue` and leaves the file byte-identical.
- `test/gui-client-settings.test.ts`: `renderSettings` emits one `data-action='unset'` Clear button per curated key (alongside the existing per-row Save counts); `clearSetting` posts `{ key: "model" }` to `/api/config-unset` and flashes `Unset model (was "gpt-5")`, flashes `Nothing to unset for …` when the response omits `oldValue`, and flashes the `error:` pattern on a thrown refusal; the existing `saveSetting` cases stay green; a string assertion pins `GUI_CLIENT_BOOT_JS` to the `data-action='unset'` click selector, beside its existing `settings: "settings-view"` routing assertions.
- `docs/how-it-works.md` describes the Settings Clear action and names `tumwater config unset` as the path it shares.
- `npm run test` is green.

### Show the durable land queue in the TUI Pending pane, matching `tumwater queue` (planned 2026-10-11 by plan; sibling of the waiting dashboard Pending-view land-queue plan and of the landed `tumwater queue` CLI command, and the TUI half of that read surface; independently landable — it reuses `src/landing/landing-queue.ts`'s `readLandingQueue` and `src/landing/landing-queue-render.ts`'s `renderLandingQueue`, the CLI's own reader/renderer, rather than a copy, so the CLI, dashboard, and TUI cannot drift; shares `src/ui/tui/tui-keys.ts` with the waiting role-scoped TUI History plan — a landing conflict is possible and the resolver handles it; no new view, key, or hint; done 2026-10-11 by feature)

**Goal.** The TUI's Pending pane (`Ctrl+T` to Pending; `tui-keys.ts`'s `view ===
roleIds.length + 5` branch) renders only `collectFleetChanges`'s unlanded-change roster, while
`tumwater queue` lists the durable land queue and the dashboard Pending plan adds the same
entries to its view. Add the queue above the roster in the TUI pane, reading and rendering it
through the CLI's existing `readLandingQueue`/`renderLandingQueue` pair so the three surfaces
agree on order, age, skips, and wording.

**Approach.**
1. `src/ui/tui/tui-keys.ts`: import `readLandingQueue` from
   `../../landing/landing-queue.js` and `renderLandingQueue` from
   `../../landing/landing-queue-render.js`. In the Pending branch, before kicking off the async
   collector, compute `const queueText = renderLandingQueue(readLandingQueue(root), now())` —
   the factory's injected `now` clock, so the printed age is pinnable in a test — and set
   `paneCache = queueText` immediately, so the queue paints on entry instead of waiting on git
   plumbing.
2. In the collector's resolution arm, keep the existing "the Pending view is still current"
   guard and set `paneCache = queueText + "\n\n" + renderFleetChange(fleet)`. In the rejection
   arm, keep the queue visible (`paneCache` stays `queueText`) and `flashError(err)` as today,
   rather than leaving the loading note over a queue that is already known.
3. `src/ui/tui/tui-pane.ts`'s pending branch is unchanged: it windows whatever string
   `paneCache` holds, so the queue-plus-roster text flows through its existing
   `entryBodyWindow`. No new view, `Ctrl+T` index, `tabStrip` label, or `hintLine` key; no
   change to `tui-frame.ts` or `tui.tsx`.

**Files touched.** `src/ui/tui/tui-keys.ts`, `test/tui-keys.test.ts`,
`docs/how-it-works.md` (the TUI bullet's Pending sentence names the land queue above the
roster, beside the existing "`Ctrl+O` cycles the pane's outcome filter" sentence).

**Acceptance criteria.**
- `test/tui-keys.test.ts`, a new case: seed one queue entry with
  `enqueueLanding(root, { role: "feature", sha: "…", tick: 3, summary: "…", enqueuedAt: 0 })`
  and wire a `collectPending` that returns a two-role `FleetChangeView`; `syncSnapshot`, then
  `Ctrl+T` five times into Pending. Before the collector resolves, `state().paneCache` equals
  `renderLandingQueue(readLandingQueue(root), 0)` — the queue renders without the git read. After
  it resolves, `state().paneCache` equals that same queue text plus `"\n\n"` plus
  `renderFleetChange(fleet)`. With no queue files seeded, the queue half is `land queue empty`.
- The existing pending cases stay green: a resolution after the operator cycled away, and one
  after a roster change remapped the raw index onto another view, both still write no cache —
  the shifted-view case now asserts the cache is unchanged, still the queue text written on
  entry, rather than null; the pre-resolution `paneCache === null` assertion in
  "the Pending pane caches the rendered fleet roster…" becomes the queue text (the immediate set
  is the behavior change).
- `docs/how-it-works.md`'s TUI bullet says the Pending pane shows the land queue above the
  pending-change roster, naming `tumwater queue` as the CLI view it matches.
- `npm run test` is green.

### Run the configured notify hook once: `tumwater notify --test` (planned 2026-10-10 by plan; independent of the waiting TUI Usage/Failures `--since`, TUI History `--result`, and `tumwater queue` plans — a new CLI command over `src/events/notify.ts` and `src/config`, no `src/ui/tui`, `src/history` or `src/landing` file; completes the operator's push channel, which today can only be exercised by waiting for a real event; done 2026-10-10 by feature)

**Goal.** The `notify` hook (tumwater.json's `notify` shell command, run by
`newNotifier` on nine allowlisted events) is the fleet's one push channel, but an operator who
writes one has no way to check it: the hook fires only when a budget pause, failed landing, or
posted question happens. Add `tumwater notify --test`: run the configured command once with a
synthetic `TUMWATER_EVENT_TYPE`/`TUMWATER_EVENT_LOOP`/`TUMWATER_EVENT_MESSAGE` environment,
inherit its stdio so its effect (a desktop notification, a posted webhook, an appended line) is
visible, and report its exit code. The default is opinionated and single: one fixed
representative allowlisted event (`land_failed`, loop `harness`, message `tumwater notify
--test`), no per-type or per-message flags — the goal is to prove the hook runs, not to replay
a specific page.

**Approach.**
1. `src/events/notify.ts`: add `export function notifyCommandEnv(type: string, loop: string,
   message: string): NodeJS.ProcessEnv` returning `childEnv({ TUMWATER_EVENT_TYPE: type,
   TUMWATER_EVENT_LOOP: loop, TUMWATER_EVENT_MESSAGE: message })`, and use it in
   `newNotifier`'s spawn (`env: notifyCommandEnv(event.type, event.loop,
   stripTerminalControls(formatEvent(event)))`). The three variable names then have one home,
   so the notifier and the test command cannot drift.
2. New `notify-command.ts` in `src/cli/` (the command-module convention beside
   `src/cli/log-commands.ts`): module constants `NOTIFY_TEST_TYPE = "land_failed"`,
   `NOTIFY_TEST_LOOP = "harness"`, `NOTIFY_TEST_MESSAGE = "tumwater notify --test"`; and
   `export async function cmdNotify(root: string, args: string[]): Promise<void>`:
   - `if (!args.includes("--test")) fail("usage: tumwater notify --test")`.
   - `const command = loadConfig(root).notify`; when it is not a non-empty string,
     `fail("notify is not configured (set `notify` in tumwater.json)")`.
   - `say(`running the notify hook (TUMWATER_EVENT_TYPE=${NOTIFY_TEST_TYPE}) …`)`, then await a
     local `runNotifyHook(command, env): Promise<number>` helper — `spawn(command, [], {
     shell: true, stdio: "inherit", env })`, resolve the `close` code (`?? 1`) and resolve
     `127` on the `error` event. Unlike the notifier's detached fire-and-forget spawn, this one
     is awaited with inherited stdio, so the operator sees the hook's own output and its exit.
   - `code === 0` → `say("notify hook exited 0")`; otherwise
     `say(`notify hook exited with code ${code}`)` and `process.exitCode = 1`.
   - No event is logged: a test run is a diagnostic and leaves the event log and every other
     harness state file untouched.
3. `src/cli.ts`: import `cmdNotify`; add a `case "notify":` beside `case "logs":`:
   `rejectUnknownArgs("notify", args, [{ names: ["--test"] }])`, then `await
   requireReadyRepo(root)`, then `await cmdNotify(root, args)`.
4. `src/cli/help.ts`: add a `  tumwater notify --test` stanza beside the `logs` stanzas —
   "Run the configured notify hook once with a synthetic event so the command can be checked
   before a real page".
5. `README.md`: in the settings paragraph's `notify` parenthetical, add "verify it with
   `tumwater notify --test`".
6. No new runtime dependency; the notifier's firing behavior, the allowlist, and the
   orchestrator wiring are unchanged — only the env-var names move behind the new helper.

**Files touched.** `src/events/notify.ts`, a new `notify-command.ts` in `src/cli/`, `src/cli.ts`,
`src/cli/help.ts`, `README.md`, `test/notify.test.ts` (the pinned env assertions stay green
with `newNotifier` now using the helper), a new `notify-command.test.ts` in `test/`,
`test/help.test.ts`.

**Acceptance criteria.**
- `test/notify.test.ts`, a new case: `notifyCommandEnv("budget_paused", "feature", "m")`
  returns exactly those three `TUMWATER_EVENT_*` keys and values. The existing spawn/env cases
  stay green (the notifier's rendered message and throttle are unchanged).
- A new `notify-command.test.ts` in `test/` over `initializedRepo()` with `setConfigKey(repo,
  "notify", recorderCommand(out))` (the `test/notify.test.ts` recorder: `echo
  "$TUMWATER_EVENT_TYPE|$TUMWATER_EVENT_LOOP|$TUMWATER_EVENT_MESSAGE" >> <out>`) and the
  `cli(repo, ...)` harness: bare `notify` exits non-zero naming `usage: tumwater notify --test`;
  with no `notify` configured, `notify --test` exits non-zero naming the missing setting; with
  the recorder it exits 0, records exactly one line whose fields are
  `land_failed|harness|tumwater notify --test`, and its stdout names the hook run; a hook that
  exits 3 makes `notify --test` exit non-zero and print the code.
- `test/help.test.ts`: `ALL_COMMANDS` gains `"notify"` (its "names exactly the commands the full
  help lists" case then passes), and `helpTopic("notify")` starts `  tumwater notify`.
- `npm run test` is green.

### Role-scoped History pane in `tumwater tui`, matching `tumwater history --role <id>` (planned 2026-10-11 by plan; sibling of the landed GUI History Loop picker (`histRole` in src/ui/gui/gui-client-history.ts) and of the landed TUI `Ctrl+G` report scope; the TUI History pane filters by trailing window (Ctrl+S) and outcome class (Ctrl+O) but not by loop, so the exact-loop filter `tumwater history --role <id>` and the dashboard picker both have no TUI surface; independent of the waiting `tumwater notify --test`, dashboard land-queue, and remainder-and-cause plans — TUI-only, no `src/cli`, `src/events`, `src/landing`, or `src/failure` file; done 2026-10-11 by feature)

**Goal.** `tumwater history --role <id>` filters tick rows to one loop's exact id, and the
dashboard's History view has a Loop picker for it, but the TUI's History pane shows only the
fleet-wide read — an operator watching a busy fleet cannot narrow the pane to one loop. Add a
session loop scope to the pane, cycled with `Ctrl+G` (the panes' scope key), so the TUI, the CLI,
and the GUI read the same rows. History's filter is exact-loop, not the report panes' base-role
aggregation: the scope cycles the raw `roleIds` (so `feature` and `feature-2` are separate slots),
matching `tumwater history --role` and the GUI picker, and never runs through `scopeCycle`/`baseRoleOf`.

**Approach.**
1. `src/ui/tui/tui-keys.ts`:
   - `historyPaneCache(root, sinceMs, resultClass, role: string | null)` gains the role and
     passes it to `readTickRows(root, HISTORY_DEFAULT_TICKS, role)` and
     `readTickRowsSince(root, sinceMs, role)` (both already take it). Prefix the pane header,
     when `role !== null`, with a `role: <role>` line beside the existing `window:`/`result:`
     labels. Keep the current empty-return rule (a role-only empty read returns `""`, so the
     pane's `(no ticks yet)` note stands, exactly as the CLI's empty-state wording does not name
     `--role`).
   - Add `let historyRole: string | null = null` beside `historyResult`, add
     `historyRole: string | null` to `TuiKeysState`, and return it from the state getter.
   - In the `Ctrl+G` branch: when the current view is History (`view === roleIds.length + 4`),
     cycle `historyRole` through `[null, ...roleIds]` (the raw roster ids; the same list the GUI
     picker and `tumwater history --role` use) via the index-of-then-`+1`-mod-length pattern,
     then recompute `paneCache = historyPaneCache(root, historyWindow, historyResult, historyRole)`
     and reset `paneScroll = 0`; on every other view keep cycling `scopeRole` for Usage/Failures
     exactly as today. `deps.requestRender()` in both arms.
   - Every other `historyPaneCache` call site (the Ctrl+T History entry, `Ctrl+S`, `Ctrl+O`)
     passes `historyRole`.
   - `syncSnapshot`: when `historyRole` is non-null and the incoming `roles` no longer includes
     it, reset it to null (mirroring the existing `scopeRole` reset), so a retired loop's id
     never labels an empty pane.
2. `src/ui/tui/tui-frame.ts`: the `TuiView` `history` variant gains `role: string | null`;
   `tabStrip` labels the tab `History: <role>` when scoped and plain `History` otherwise (mirroring
   `Usage`/`Failures`); the history arm of `hintLine` gains
   `["Ctrl+G", view.role ? `scope: ${view.role}` : "scope: fleet"]` after the scroll hint, so the
   key and the current loop are both on screen.
3. `src/ui/tui/tui.tsx`: the History pane construction passes `role: s.historyRole`.
4. No change to `tui-pane.ts` (the cache already is the pane body), the collectors, or any other
   surface; no new runtime dependency.

**Files touched.** `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`,
`test/tui-keys.test.ts`, `test/tui-frame.test.ts`.

**Acceptance criteria.**
- `test/tui-keys.test.ts`, a new case with `syncSnapshot(0, false, ["feature", "feature-2", "clean"])`
  and seeded `tick_end` events for two loops: after cycling to History, `Ctrl+G` moves
  `state().historyRole` from `null` to `"feature"` to `"feature-2"` to `"clean"` to `null` — the
  instance id is its own slot, unlike the report scope — and each press on the History view
  recomputes `paneCache` so a scoped cache differs from the fleet-wide one; `Ctrl+G` leaves
  `historyRole` unchanged while budget mode or role-prompt mode holds the prompt line; a later
  `syncSnapshot` whose roster drops the scoped loop resets `historyRole` to null. The existing
  Ctrl+G report-scope cases stay green (other views still cycle `scopeRole`).
- `test/tui-frame.test.ts`: `tabStrip({ kind: "history", since: null, result: null, role: "feature" },
  200)` shows `History: feature` while `role: null` shows `History`; `hintLine` for a history view
  carries `Ctrl+G scope: feature` under a scope and `Ctrl+G scope: fleet` without one. The
  existing history window/result hint cases and the all-views `Ctrl+D` loop stay green (their
  literals gain `role: null`).
- `test/tui-history.test.ts`'s `paneBody` history cases stay green (their literals gain
  `role: null`; the pane body reads the already-scoped cache, not the role).
- `npm run test` is green.

### A remainder-and-cause trace: a capped view discloses what it dropped, and a failed decision records the cause it acted on (planned 2026-10-10 by steward; promoted from the `no-observability` validation gap, carried by 58 Fixed entries — the largest non-`none` tag after `unclear-invariant`; independent of the Agent backends and citation-sweep series; follow-up to the landed invariant register and its citation guard; done 2026-10-11 by feature)

**Goal.** Retire the `no-observability` gap. It is recorded when a failure or a wrong decision
left no trace, so a fixer could neither detect it nor reconstruct the inputs it acted on. Give the
project a trace contract with two rules a landing can be checked against: **a capped or narrowed
view discloses in its output what it dropped**, and **a terminal failure records the cause it
decided from rather than a defaulted pass or a bare count**.

**Evidence.** The validation-gap tally (`grep -oE 'gap:[*]{0,2} ?[a-z-]+' BUGS.md | sed -E
's/^gap:[*]{0,2} ?//' | sort | uniq -c`) shows `no-observability` on 58 Fixed entries, second only
to `unclear-invariant` (97) and the largest tag with no retiring infrastructure plan; 9 are still
kept verbatim and the rest survive as `; gap: no-observability` one-liners. The recurring families,
each visible in the cited entries:
- **A capped section prints no remainder.** The failure digest's loss ranking keeps the top 5
  causes and itemizes the rest nowhere ("The failure digest's 'Top loss causes by time' ranking is
  cut to the top 5 causes by time…", fixed 2026-10-01), while sibling sections already disclose
  their cuts (`+21 more`, `+46 more`); its Review rejections section truncates at 5
  alphabetically-first clusters ("The digest's Review rejections section silently truncates at 5
  alphabetically-first clusters…"), and its Fleet state changes section keeps only the newest 6
  transitions ("The digest's Fleet state changes section silently keeps only the newest 6
  transitions…").
- **A failure path records a pass, a silence, or a bare count.** A malformed FLOW line defaults to
  `passed` ("A FLOW line without a parseable verdict is recorded as a pass…"); a signal-killed
  build check is reported as a timeout ("A build check killed by a signal is reported as 'timed
  out after 300s'…"); `quiet_killed` is the only outcome with no strike cap, backoff, or alarm
  ("`quiet_killed` is the only tick outcome with no strike cap, no backoff and no alarm…"); a
  persistent review failure never reaches the error-streak alarm ("A persistent review failure
  never reaches the error-streak alarm…").
- **A label names the wrong evidence.** Build-check rejections name a stack frame instead of the
  failing test ("Build-check rejections name the stack frame instead of the failing test…"); a
  role over-cap rejection names the director's prefill whatever loop it targets ("A role prompt's
  over-cap rejection names the director's prefill whatever loop it targets…").
Seed the contract from these families, and add sections as new ones recur.

**Approach.**
1. Add one shared remainder helper beside the render/text helpers, producing the digest's existing
   `_+N more … not listed_` / `(+N unreadable …)` shape, and apply it to every view that currently
   cuts silently — starting with the digest's loss ranking, Review rejections, and Fleet state
   changes, and the per-role rejection counter. The count is derived from the same list the view
   already builds, so the marker cannot drift from the cut.
2. Give the terminal-outcome paths a cause field. `extractFlow` and the killed-specific-check
   paths record the observed cause (a malformed/truncated verdict, a signal kill) as a distinct
   value, never a defaulted `passed`; `quiet_killed` and the other unalarmed outcomes feed the
   existing streak/backoff machinery. A wrong or absent cause is then an assertion a test can fail
   on, not prose.
3. State the contract where a fixer reads it. Name the trace rule in the invariants register
   (docs/invariants.md) beside the boundary families, so a landing that adds a capped view or a
   terminal outcome updates the record shape in the same commit.
4. No new runtime dependency and no change to the loop pipeline.

**Files touched.** the render/text helpers and `src/failure/` renderers; `src/verdict/` (extractFlow)
and the build-check/kill outcome paths; `docs/invariants.md`; the `test/...` cases below.

**Acceptance criteria.**
- A digest render seeded with more loss causes, review clusters, and fleet transitions than each
  section's cap prints the marked remainder (hidden count, not silent), under a test per section;
  the cap-size-seeded render is byte-unchanged.
- A malformed or truncated FLOW line records a non-`passed` outcome, and a signal-killed build
  check event carries its kill cause distinct from a timeout, each under a test.
- The invariants register states the remainder-and-cause rule and cites the `test/...` cases that
  pin it, so the citation guard (the landed "Keep the invariant register honest…") covers the new
  sections.
- `npm run test` is green.

**Landed.** The capped-section remainder lines and both cause recordings this plan asked for
already rode individual fixes before this tick; they are now stated and pinned as the register's
`INV-D1`/`INV-D2` contract (docs/invariants.md). This tick added that register entry and moved
this plan to Done. No shared remainder helper was extracted: the four digest remainders carry
different wording ("older transitions hidden", "loss causes by time not listed", "clusters
holding N", "older merges not listed") and already share the `agree`/`plural` helpers, so a
single formatter would add parameters without removing a computation.

### Show the durable land queue in the dashboard's Pending view, matching `tumwater queue` (planned 2026-10-10 by plan; sibling of the landed `tumwater queue` CLI command and the landed dashboard Pending view; completes the land queue's read surfaces on the dashboard, which today show only the header depth badge `· land queue: N` — the entries already ride `/api/status`'s `landQueue.entries` and are polled every second but never painted; independent of the waiting TUI History `--result`, CLI `notify --test`, and remainder-and-cause trace plans — GUI-only, no `src/ui/tui`, `src/history`, `src/events`, or `src/failure` file; done 2026-10-11 by feature)

**Goal.** The dashboard's Pending view shows every loop's unlanded change (from `/api/diff`) and
its header badge shows the queue depth (`· land queue: N`, src/ui/badges.ts `landingBadge`), but
the waiting landings themselves — role, tick, short sha, age, summary, in execution order — are
visible only through `tumwater queue` or `tumwater status --json`. The status payload the page
already polls each second carries them at `landQueue.entries` (StatusSnapshot, filled from
`readLandingQueue`). Paint a "Land queue" card at the top of the Pending view from that payload,
so an operator watching the browser sees what the landing slot will merge next without leaving
the page.

**Approach.**
1. `src/ui/gui/gui-client-pending.ts`, inside the `pending-table` marked region (so `clientScope`
   can run it): add the pure `pendingQueueHtml(landQueue, now)`.
   - Non-empty readable `entries`: one row per entry in array order, `<n>. <role> tick #<tick> ·
     <shortSha(sha)> · <humanSeconds((now - enqueuedAt) / 1000)> ago · <summary>` — the same
     fields and order as `renderLandingQueue` (src/landing/landing-queue-render.ts), so the page
     and the CLI cannot drift. `shortSha`/`humanSeconds` come from the assembled script's
     `format` region (the test already loads it beside `pending-table`) and `esc` from the
     script's own `esc`.
   - `landQueue` absent or `depth === 0`: `Land queue empty`.
   - `depth > 0` with `entries` absent or not an array: `land queue: <depth> waiting` (the depth
     also counts the unreadable queue files the status reader skips; the payload carries no
     split, so the card states the count without inventing an itemization).
   - Guard a non-array `entries`, a missing `sha`, and a non-finite `enqueuedAt` so no row prints
     `undefined` or `NaN`.
2. `buildPendingView()` gains a `<div class="card" id="pendingqueue">` above `#pendingbody`, and
   `fetchPending()` paints it through a `renderPendingQueue()` that reads `lastStatus &&
   lastStatus.landQueue` (the polled payload, no new fetch) and calls `pendingQueueHtml` with
   `Date.now()`.
3. `src/ui/gui/gui-client-boot.ts`: `rerender()` gains `if (activeView === "pending")
   renderPendingQueue(lastStatus);` beside its fleet line, so the card tracks the one-second
   status poll while the view is open; the roster keeps its own open/Refresh `/api/diff` fetch.
4. No server change: `landQueue.entries` already rides `/api/status` (src/ui/status-payload.ts
   passes `snap.landQueue` through), and the Pending view's pure-function test seam already
   loads the `format` region.

**Files touched.** `src/ui/gui/gui-client-pending.ts`, `src/ui/gui/gui-client-boot.ts`,
`test/gui-client-pending.test.ts`.

**Acceptance criteria.**
- `test/gui-client-pending.test.ts`, a new case over `pendingQueueHtml({ depth, entries }, now)`
  with two entries: the rows appear in array order, each carrying its 1-based position, role,
  `tick #<tick>`, the sha's first eight characters, an age derived from the fixed `now`, and the
  summary.
- `pendingQueueHtml({ depth: 0 }, now)` and `pendingQueueHtml(null, now)` both carry `Land queue
  empty`; `pendingQueueHtml({ depth: 2 }, now)` with the readable list absent carries `land
  queue: 2 waiting`.
- An escaping case (a role and summary containing markup render escaped) and a malformed-
  document case (`entries` not an array, `sha`/`enqueuedAt` missing) render without `undefined`
  or `NaN`.
- The existing `pendingTableHtml` cases stay green, and `GUI_CLIENT_JS` still carries the module
  verbatim (its existing case covers the new function, which lives in the same region).
- `npm run test` is green.
### Filter the TUI History pane by outcome class, matching `tumwater history --result` (planned 2026-10-10 by plan; sibling of the landed CLI `tumwater history --result <changes|none|problems>` and the landed dashboard History outcome filter; completes that outcome filter on the TUI's History pane, reading the same canonical `historyClass` rule from `src/history/history-data.ts`; shares `src/ui/tui/tui-keys.ts`/`tui-frame.ts` with the waiting TUI Usage/Failures `--since` plan — both add one session cycle and one hint pair — so a landing conflict is possible and the resolver handles it; done 2026-10-10 by feature)

**Goal.** The TUI History pane now offers the `Ctrl+S` trailing window (landed), but it renders
`readTickRows`/`readTickRowsSince` rows unfiltered, while `tumwater history --result
<changes|none|problems>` and the dashboard's History view narrow ticks to one outcome class
(Changes / No change / Problems). Add a session-only outcome cycle keyed `Ctrl+O` (mnemonic:
**O**utcome) that keeps only rows whose result falls in the active class, composing with the
active trailing window, and surface the active class in the hint line. The pane reuses
`history-data.ts`'s `historyClass`/`HISTORY_RESULT_CLASSES` rather than a copy, so the TUI, the
CLI, and the dashboard bucket a result the same way.

**Approach.**
1. `src/ui/tui/tui-keys.ts`: import `historyClass`, `HISTORY_RESULT_CLASSES`, and `type
   HistoryResultClass` from `../../history/history-data.js`. Add a module constant
   `HISTORY_RESULTS: ReadonlyArray<[HistoryResultClass | null, string]>` = `[[null, "all"],
   ...HISTORY_RESULT_CLASSES.map((c) => [c, c] as const)]` — the label is the class id, matching
   the CLI's accepted values, and the class list comes from `history-data.ts` rather than a copy —
   and a module helper `historyResultLabel(resultClass: HistoryResultClass | null): string |
   null` (the table lookup, null only for a would-be stale value). Add `let historyResult:
   HistoryResultClass | null = null` beside `historyWindow`, commented session-only like it.
2. Extend the existing `historyPaneCache` to `historyPaneCache(root, sinceMs, resultClass)`. The
   default path (`sinceMs === null && resultClass === null`) stays byte-for-byte the current
   `historyPaneText(readTickRows(root, HISTORY_DEFAULT_TICKS, null))`. Otherwise read through the
   window collector (`readTickRows` for the default, `readTickRowsSince` otherwise), filter
   `resultClass === null ? rows : rows.filter((r) => historyClass(r.result) === resultClass)`,
   and render header lines — `window: last <label>` when a window is active and
   `result: <label>` when a class is active — followed by the filtered body. When a class is
   active, the unfiltered read returned rows (`rows.length > 0` — the CLI's `afterGrep > 0` and
   the dashboard's `hasRows` rule), and the filtered body is empty, return the header plus
   `no ticks with result "<label>"` (the CLI's exact wording); otherwise (no class, or the read
   itself was empty) return `""` so an empty log or window keeps the pane's own `(no ticks yet)`
   note rather than blaming a filter that removed nothing; keep `SPARSE_WINDOW_NOTE` when the
   since read is not `covered` and rows remain.
3. Add a `Ctrl+O` branch beside the `Ctrl+S` branch, gated `!budgetMode && !rolePromptFor` like
   it: advance `historyResult` to the next `HISTORY_RESULTS` entry (index-of, `+1` mod length);
   when `view === roleIds.length + 4` (History) recompute `paneCache = historyPaneCache(root,
   historyWindow, historyResult)` and set `paneScroll = 0` so the changed body re-enters at its
   head; always `deps.requestRender()`. Off the History view, setting `historyResult` is enough —
   the next Ctrl+T into History computes with it.
4. Pass `historyResult` at the two existing History call sites: the `Ctrl+S` recompute and the
   Ctrl+T History-entry `paneCache = historyPaneCache(root, historyWindow, historyResult)`.
5. Expose `historyResult: string | null` on `TuiKeysState` (the active label via
   `historyResultLabel`, null when none) and return it from `state()`, beside `historySince`.
6. `src/ui/tui/tui-frame.ts`: the `TuiView` `history` variant gains `result: string | null`;
   the `hintLine` history branch gains `["Ctrl+O", view.result ? \`result: ${view.result}\` :
   "result: all"]` after the `Ctrl+S` pair. `tabStrip` stays `History` unchanged.
7. `src/ui/tui/tui.tsx`: build the History pane as `{ kind: "history", since: s.historySince,
   result: s.historyResult }` from the state it already reads.
8. Update the existing `{ kind: "history", since: ... }` literals in `test/tui-frame.test.ts`
   and `test/tui-history.test.ts` to carry `result: null`.

**Files touched.** `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`,
`test/tui-keys.test.ts`, `test/tui-frame.test.ts`, `test/tui-history.test.ts`,
`docs/how-it-works.md`.

**Acceptance criteria.**
- `test/tui-keys.test.ts`, a new case: seed three `feature` `tick_end` events with results
  `changed`, `no_change`, and `error` (all inside the default newest-N read), `syncSnapshot(0,
  false, [])`, then Ctrl+T into History: `state().historyResult` is `"all"` and the pane carries
  all three. Ctrl+O cycles `"changes"`, `"none"`, `"problems"`, then back to `"all"`; under
  `"changes"` the pane carries the changed row and neither the no-change nor the error row, under
  `"none"` the no-change row alone, under `"problems"` the error row alone, and the body's header
  line reads `result: <class>`; each press on the History view resets `paneScroll` to 0. Compose
  with Ctrl+S: after Ctrl+S to `1h`, a filter whose only matching tick is older than an hour
  leaves the pane showing `no ticks with result "<class>"`. An active class over a read that
  returned zero rows (an empty log) leaves `paneCache` as `""`, keeping the pane's own no-ticks
  note. `docs/how-it-works.md`'s TUI section documents the `Ctrl+O` cycle beside the `Ctrl+S`
  window sentence.
- `test/tui-keys.test.ts`: Ctrl+O leaves `historyResult` unchanged while budget mode or
  role-prompt mode holds the prompt line, and pressing it off the History view changes the label
  without computing a cache (the off-view preamble Ctrl+S uses).
- `test/tui-frame.test.ts`: `hintLine({ kind: "history", since: null, result: "problems" }, ...)`
  carries a `Ctrl+O` hint naming `result: problems`, while `result: null` names `result: all`; the
  existing `{ kind: "history", ... }` literals there and in `test/tui-history.test.ts` gain
  `result: null` and their assertions are otherwise unchanged.
- The existing Ctrl+S History window cases stay green (the default path is unchanged when no
  class is active).
- `npm run test` is green.

### A trailing `--since` window on the TUI Usage and Failures panes, matching `tumwater report --since` (planned 2026-10-10 by plan; sibling of the landed dashboard Usage/Failures `--since`; completes the CLI's `report --since` / `report --failures --since` on the TUI's two report panes; independent of the waiting `Ctrl+G` scope plan and of the waiting TUI History `--since` plan in its own window state and key — its own `reportWindow`, a different `Ctrl+E` — though it edits the same two Ctrl+T report branches and hintLine region as the `Ctrl+G` plan, so a landing conflict is possible and the resolver handles it; done 2026-10-10 by feature)

**Goal.** `tumwater report --since <duration>` totals usage over a trailing window and
`tumwater report --failures --since <duration>` windows the failure digest, both capped at
`REPORT_SINCE_MAX_MS` (7d), and the dashboard's Usage/Failures tabs now offer the same
1h/6h/1d choice. The TUI's Usage and Failures panes still render only the whole-day shape
(`REPORT_DEFAULT_DAYS`) via `collectReport` / `collectFailureReport`, so the TUI is the one
surface that cannot ask either report for the last hour or day. Add a session-only window cycle,
keyed `Ctrl+E`, that reads through the same `collectReportSince` / `collectFailureReportSince`
collectors and the same Markdown renders the CLI and dashboard use.

**Approach.**
1. `src/ui/tui/tui-keys.ts`: import `collectReportSince` from `../../report/report-data.js`,
   `renderSinceReportMarkdown` from `../../report/report-render.js`, `collectFailureReportSince`
   from `../../failure/failure-data.js`, and `REPORT_SINCE_MAX_MS` from
   `../../events/event-window.js`. Add a module constant `REPORT_WINDOWS:
   ReadonlyArray<[number | null, string]>` = `[[null, "default"], [3_600_000, "1h"],
   [21_600_000, "6h"], [86_400_000, "1d"], [REPORT_SINCE_MAX_MS, "7d"]]`, and two module
   helpers `usagePaneCache(root: string, sinceMs: number | null): string` and
   `failuresPaneCache(root: string, sinceMs: number | null): string`: at `sinceMs === null`
   return the existing day shape (`renderReportMarkdown(collectReport(root,
   REPORT_DEFAULT_DAYS))` / `renderFailureMarkdown(collectFailureReport(root,
   REPORT_DEFAULT_DAYS))`) unchanged; otherwise return
   `renderSinceReportMarkdown(collectReportSince(root, sinceMs))` /
   `renderFailureMarkdown(collectFailureReportSince(root, sinceMs))`. The since renders already
   print their own `window: last <label>` line, so the pane body needs no extra label.
2. Add `let reportWindow: number | null = null` beside the `paneCache` state (session-only, like
   the view/scroll state). In the Ctrl+T handler the Usage branch becomes
   `paneCache = usagePaneCache(root, reportWindow)` and the Failures branch
   `paneCache = failuresPaneCache(root, reportWindow)`. Add a `Ctrl+E` branch beside the Ctrl+N
   branch, gated `!budgetMode && !rolePromptFor` like the other mode-sensitive keys: advance
   `reportWindow` to the next `REPORT_WINDOWS` entry (index-of, `+1` mod length); when
   `view === roleIds.length + 2` (Usage) or `view === roleIds.length + 3` (Failures) recompute
   `paneCache` from the matching helper and reset `paneScroll = 0` so the changed body re-enters
   at its head; always `deps.requestRender()`. Off both report views, setting `reportWindow` is
   enough — the next Ctrl+T entry computes with it.
3. Expose the window on `TuiKeysState` as `reportSince: string | null`, the `REPORT_WINDOWS`
   label for `reportWindow` (null while it is null), and return it from `state()`.
4. `src/ui/tui/tui-frame.ts`: the `TuiView` `usage` and `failures` variants gain
   `window: string | null`. Split the shared
   `usage || failures || history || pending` branch of `hintLine` so `usage`/`failures` get their
   own key list, carrying `["Ctrl+E", view.window ? \`window: ${view.window}\` : "window:
   default"]` before the `Ctrl+T`/`Ctrl+D` pairs (the remaining `history || pending` branch is
   unchanged). `tabStrip` stays as it is (plain `Usage` / `Failures`).
5. `src/ui/tui/tui.tsx`: build the two panes as `{ kind: "usage", window: s.reportSince }` and
   `{ kind: "failures", window: s.reportSince }` from the state it already reads.
6. No new runtime dependency; the role scope (`scopeRole`, the `Ctrl+G` plan) and the History
   pane are untouched, and `paneBody` reads only `paneCache` so it needs no change.

**Files touched.** `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`,
`test/tui-keys.test.ts`, `test/tui-frame.test.ts` (plus the `{ kind: "usage" }` /
`{ kind: "failures" }` literals in `test/tui-frame.test.ts` gain `window: null`).

**Acceptance criteria.**
- `test/tui-keys.test.ts`, a new case: seed one `feature` `tick_end` with tokens 30 min old and
   one 3 days old (both ts derived from one `Date.now()` read), `syncSnapshot(0, false, [])`, then
   Ctrl+T into Usage and press Ctrl+E: `state().reportSince` cycles `"1h"`, `"6h"`, `"1d"`,
   `"7d"`, `null`; under `"1h"` the cached pane carries the 30-min tick's tokens and not the
   3-day tick's, and under `null` it carries both; each press on the Usage view resets
   `paneScroll` to 0. The same cycle on the Failures view with an error-result tick inside the
   hour and one outside. Ctrl+E leaves `reportSince` unchanged while budget mode or role-prompt
   mode holds the prompt line, and pressing it off both report views changes the label without
   recomputing a cache.
- `test/tui-frame.test.ts`: `hintLine({ kind: "usage", window: "1h" }, ...)` carries a `Ctrl+E`
   hint naming `window: 1h`, while `window: null` names `window: default`; the same for
   `failures`; the `{ kind: "usage" }` / `{ kind: "failures" }` literals in the existing
   frame/hint/tab-strip cases become `{ kind: "usage", window: null }` /
   `{ kind: "failures", window: null }` and their assertions are otherwise unchanged.
- The existing Ctrl+T Usage/Failures cache cases stay green (the default window is unchanged).
- `npm run test` is green.

### List the durable land queue in execution order: `tumwater queue [--json]` (planned 2026-10-10 by plan; independent of the waiting TUI Usage/Failures `--since` and CLI history `--result` plans — a new CLI command over `src/landing`, no `src/ui/tui` or `src/history` file; completes the land queue's read surfaces, which today expose its depth in the status header and its entries only through `tumwater status --json`'s `landQueue` object, never as a command of its own; done 2026-10-10 by feature)

**Goal.** The orchestrator's landing slot drains the durable land queue (`src/landing/landing-queue.ts`) oldest-first, but no command lists the waiting landings: `tumwater status` shows only the header depth and `tumwater status --json` buries the entries inside the whole fleet snapshot. Add `tumwater queue [--json]`: every readable entry in execution order (position, loop, tick number, short pinned sha, age, summary), a `land queue empty` line for an empty queue, and a count of the torn/foreign queue files the reader skips.

**Approach.**
1. `src/landing/landing-queue.ts`: add `export interface LandingQueueView { entries: LandingEntry[]; unreadable: number }` and `export function readLandingQueue(root: string): LandingQueueView` — one pass over the private `queueFiles(root)` through the existing `readEntry`, pushing readable entries in filename order and counting the rest. The queue's depth is `entries.length + unreadable`, so no second directory listing is needed. This is the one home of "the queue as a view", beside its readers.
2. `src/status/status-data.ts`: replace the `queuedLandings(root)` read with `readLandingQueue(root)` so the status payload's `landQueue.entries` and the new command cannot drift. Keep the same projection (`{role, sha, tick, summary, enqueuedAt}`) and the `entries?` guard on a non-empty readable list (`view.entries.length > 0`), and use `view.entries` for the `liveLandingMarker` sha set; `depth` becomes `view.entries.length + view.unreadable`. Update the doc comments that name `queuedLandings`.
3. A new render-half module `landing-queue-render.ts` beside `landing-queue.ts` in `src/landing/` (the `change-render.ts`/`backlog-render.ts` convention): `export function renderLandingQueue(view: LandingQueueView, now: number): string` — a `land queue (<depth>):` header then one 1-based line per entry, `  <n>. <role> tick #<tick> · <shortSha(sha)> · <humanSeconds(secondsSince(enqueuedAt, now))> ago · <summary>`; `depth === 0` prints `land queue empty`; `unreadable > 0` appends `  (+<n> unreadable queue file(s) skipped)`.
4. `src/cli/cli-query-commands.ts`: add `export async function cmdQueue(root, args)`: `rejectUnknownArgs("queue", args, [JSON_FLAG])`, `await requireReadyRepo(root)`, then `sayJsonOrRender(args, readLandingQueue(root), (v) => renderLandingQueue(v, Date.now()))`. The `--json` form prints the view's raw `entries` (unshortened `sha`, raw `enqueuedAt`) plus `unreadable`, the `report --json` precedent that the JSON is the collector's own document, not a re-parse of the render.
5. `src/cli.ts`: import `cmdQueue` from `./cli/cli-query-commands.js` and add `case "queue": await cmdQueue(root, args); break;` beside the other read-only query cases.
6. `src/cli/help.ts`: add a `tumwater queue [--json]` stanza beside `tumwater diff` naming the execution order, the per-entry fields, and that `--json` prints the `{entries, unreadable}` document.
7. No new runtime dependency; `status`, `diff`, the landing pipeline, and the TUI/dashboard are otherwise untouched (their depth badge and in-flight cell keep reading the same snapshot fields).

**Files touched.** `src/landing/landing-queue.ts`, a new `landing-queue-render.ts` in `src/landing/`, `src/status/status-data.ts`, `src/cli/cli-query-commands.ts`, `src/cli.ts`, `src/cli/help.ts`, `test/landing-queue.test.ts`, a new `cli-queue.test.ts` in `test/`, `test/help.test.ts`.

**Acceptance criteria.**
- `test/landing-queue.test.ts`, new cases: after three `enqueueLanding` calls with distinct `enqueuedAt` (or the same millisecond, relying on the counter), `readLandingQueue(repo).entries` is in filename order and `unreadable` is 0; a torn file written into `landQueueDir(repo)` (a junk `.json` beside the healthy entries) is skipped by `entries` and counted in `unreadable`; a missing queue directory reads as `{entries: [], unreadable: 0}`.
- A new `cli-queue.test.ts` in `test/` (`cli(repo, ...)` over an initialized repo): an empty queue prints `land queue empty` and exits 0; after two `enqueueLanding` calls, `queue` prints one line per entry oldest-first carrying the loop, `tick #<n>`, the short sha, an age, and the summary; `queue --json` prints `{entries:[...], unreadable:0}` with the raw sha and numeric `enqueuedAt`; an unknown flag exits non-zero naming the flag.
- `test/help.test.ts`: `ALL_COMMANDS` names `queue`, and `helpTopic("queue")` resolves to a stanza starting `  tumwater queue`.
- The existing `status --json` `landQueue` cases and the other `test/landing-queue.test.ts` cases stay green (the readable-entry projection is unchanged).
- `npm run test` is green.

### Filter `tumwater history` by outcome class: `--result <changes|none|problems>` (planned 2026-10-10 by plan; independent of the waiting TUI History `--since`, TUI Usage/Failures `--since`, and TUI `Ctrl+G` scope plans — CLI-only, no `src/ui/tui` file; completes the dashboard History view's outcome filter on the command line, sharing its one bucket rule; done 2026-10-10 by feature)

**Goal.** The dashboard's History view narrows ticks to an outcome class — Changes
(`changed`/`queued`), No change (`no_change`/`skipped`/`user_aborted`), Problems (everything
else, e.g. `error`/`rejected`) — beside its loop picker, text search, and count/window choice.
`tumwater history` has `--role`, `-n`, `--since`, `--grep`, and `--json` but no outcome filter,
so the command line cannot ask "which ticks errored in the last day" (`--grep` matches summary
text, not the result). Add `--result <class>` to the CLI, reading the same bucket rule the
dashboard's `historyClass` applies.

**Approach.**
1. `src/history/history-data.ts`: add `export const HISTORY_RESULT_CLASSES = ["changes",
   "none", "problems"] as const` and `export function historyClass(result: string): "changes"
   | "none" | "problems"` with the dashboard's buckets (`changed`/`queued` → `changes`;
   `no_change`/`skipped`/`user_aborted` → `none`; everything else → `problems`). This is the
   canonical rule; the browser's copy is pinned to it by a test (criterion 2).
2. `src/history/history.ts`: add `export const HISTORY_RESULT_VALUE_ERROR = "history --result
   needs a value"` beside `HISTORY_GREP_VALUE_ERROR`. After `parseGrepFlag` and the
   `--since`/`-n`/`--role` row collection, read `flagValue(rest, "--result")`: `null` → no
   filter; `undefined` or `""` → `fail(HISTORY_RESULT_VALUE_ERROR)`; a value not in
   `HISTORY_RESULT_CLASSES` → `fail` naming the accepted classes (the existing `gotSuffix`
   shape). Apply after the grep filter: `rows = rows.filter((r) => historyClass(r.result) ===
   resultClass)`. `--result` composes with `--role`, `-n`, `--since`, `--grep`, and `--json` —
   no rival-shape rule. Extend the doc comment.
3. `src/history/history.ts` empty state: keep `--grep`'s precedence; when rows are empty and
   `--result` alone is the active filter, print `no ticks with result "<class>"` (the grep
   wording's shape) instead of `no ticks yet`, so a filtered-out set is never read as a quiet
   log. `--json` stays a bare `{rows}` document in every exit-0 case.
4. `src/cli/cli-flag-specs.ts`: add `resultFlagSpec(missingValue)` beside `grepFlagSpec` —
   `{ names: ["--result"], value: true, valueName: "<class>", missingValue }` — so a trailing
   `--result` is refused at the gate with the same wording the body uses.
5. `src/cli.ts`: add `resultFlagSpec(HISTORY_RESULT_VALUE_ERROR)` to the `history` case's
   `rejectUnknownArgs` list, beside `grepFlagSpec`.
6. `src/cli/help.ts`: the `tumwater history` usage line gains `[--result
   <changes|none|problems>]` and its description notes the outcome filter composes with
   `--role`, `--since`, `-n`, and `--grep`.
7. No new runtime dependency; the dashboard's client-side filter and `/api/history` are
   unchanged.

**Files touched.** `src/history/history-data.ts`, `src/history/history.ts`,
`src/cli/cli-flag-specs.ts`, `src/cli.ts`, `src/cli/help.ts`,
`test/cli-history-filtering.test.ts`, `test/cli-history.test.ts`,
`test/gui-client-history.test.ts`.

**Acceptance criteria.**
- `test/cli-history-filtering.test.ts`, new cases against `seededHistoryRepo()` (results
   `changed`, `no_change`, `error`): `history --result changes` prints only feature #7;
   `--result none` only clean #3; `--result problems` only bugfix #9; `--result changes
   --since 1h` composes; `--result problems --json` is `{rows:[the error row]}` with no prose
   or note; `--result bogus` exits 1 naming `changes, none, problems`; a trailing `history
   --result` exits 1 with `history --result needs a value`; a result filter matching nothing
   prints `no ticks with result "<class>"`, never `no ticks yet`.
- `test/gui-client-history.test.ts`: the existing `historyClass` bucket assertion is extended
   to compare the browser function against the shared `historyClass` from `history-data.js`
   over `changed, queued, no_change, skipped, user_aborted, error, rejected`, so the two copies
   cannot drift.
- The existing `--role`, `-n`, `--since`, `--grep`, and `--json` history cases stay green.
- `npm run test` is green.

### A trailing `--since` window in the TUI History pane, matching `tumwater history --since` (planned 2026-10-10 by plan; independent of the waiting dashboard report `--since` and TUI `Ctrl+G` scope plans — different pane, its own window state, a different key; sibling of the landed dashboard History trailing window and the landed `tumwater history --since`; done 2026-10-10 by feature)

**Goal.** `tumwater history --since <duration>` reads a trailing window through `readTickRowsSince`,
and the dashboard's History view offers the same windows (1h/6h/1d/7d). The TUI's History pane
still renders only the newest `HISTORY_DEFAULT_TICKS` ticks via
`readTickRows(root, HISTORY_DEFAULT_TICKS, null)`, so the TUI is the one surface that cannot ask
for the last hour or day. Add a session-only window cycle, keyed `Ctrl+S`, that reads through the
same collector and prints the same sparse-window note the CLI prints.

**Approach.**
1. `src/ui/tui/tui-keys.ts`: import `readTickRowsSince` from `../../history/history-data.js` and
   `SPARSE_WINDOW_NOTE` from `../../events/event-window.js`. Add a module constant
   `HISTORY_WINDOWS: ReadonlyArray<[number | null, string]>` =
   `[[null, "default"], [3_600_000, "1h"], [21_600_000, "6h"], [86_400_000, "1d"], [604_800_000, "7d"]]`,
   and a module helper `historyPaneCache(root: string, sinceMs: number | null): string`:
   when `sinceMs === null` return `historyPaneText(readTickRows(root, HISTORY_DEFAULT_TICKS, null))`
   unchanged; otherwise read `const { rows, covered } = readTickRowsSince(root, sinceMs, null)`,
   return `""` when `historyPaneText(rows)` is empty (so the pane keeps its own empty note),
   and otherwise return `"window: last " + label + "\n" + body` plus, when `!covered`,
   `"\n" + SPARSE_WINDOW_NOTE`.
2. Add `let historyWindow: number | null = null` beside the `paneCache` state (session-only, like
   the view/scroll state). The Ctrl+T handler's History branch becomes
   `paneCache = historyPaneCache(root, historyWindow)`. Add a `Ctrl+S` branch beside the Ctrl+N
   branch, gated `!budgetMode && !rolePromptFor` like the other mode-sensitive keys: advance
   `historyWindow` to the next `HISTORY_WINDOWS` entry (index-of, `+1` mod length); when
   `view === roleIds.length + 4` (History) recompute `paneCache = historyPaneCache(root, historyWindow)`
   and reset `paneScroll = 0` so the changed body re-enters at its head; always
   `deps.requestRender()`. Off the History view, setting `historyWindow` is enough — the next
   Ctrl+T entry computes with it.
3. Expose the window on `TuiKeysState` as `historySince: string | null`, the `HISTORY_WINDOWS`
   label for `historyWindow` (null while it is null), and return it from `state()`.
4. `src/ui/tui/tui-frame.ts`: the `TuiView` history variant becomes
   `{ kind: "history"; since: string | null }`. Split the shared
   `usage || failures || history || pending` branch of `hintLine` so `history` has its own key
   list, carrying `["Ctrl+S", view.since ? \`window: ${view.since}\` : "window: default"]`
   before the `Ctrl+T`/`Ctrl+D` pairs; the `tabStrip` label stays `History`.
5. `src/ui/tui/tui.tsx`: build the pane as `{ kind: "history", since: s.historySince }`.
6. No new runtime dependency; the role scope, Usage/Failures panes, and Pending pane are
   untouched.

**Files touched.** `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`,
`test/tui-keys.test.ts`, `test/tui-frame.test.ts` (plus the `{ kind: "history" }` literals in
`test/tui-history.test.ts` gain `since: null`).

**Acceptance criteria.**
- `test/tui-keys.test.ts`, a new case: seed a `feature` `tick_end` 30 min old and one 3 days old
   (both ts derived from one `Date.now()` read), `syncSnapshot(0, false, [])`, then Ctrl+T into
   History and press Ctrl+S: `state().historySince` cycles `"1h"`, `"6h"`, `"1d"`, `"7d"`,
   `null`; under `"1h"` the cache carries the 30-min row and not the 3-day row, and under `null`
   it carries both; each press on the History view resets `paneScroll` to 0. Ctrl+S leaves
   `historySince` unchanged while budget mode or role-prompt mode holds the prompt line, and
   pressing it off the History view changes the label without computing a cache.
- `test/tui-frame.test.ts`: `hintLine({ kind: "history", since: "1h" }, ...)` carries a `Ctrl+S`
   hint naming `window: 1h`, while `since: null` names `window: default`; the `{ kind: "history" }`
   literals in the existing frame/hint/tab-strip cases become `{ kind: "history", since: null }`
   and their assertions are otherwise unchanged.
- The existing Ctrl+T History cache/paging case stays green (the default window is unchanged).
- `npm run test` is green.


### A trailing `--since` window on the dashboard Usage and Failures views (planned 2026-10-10 by plan; independent of the waiting dashboard History trailing-window and prompt `--edit --attach` plans; completes the CLI's `report --since` and `report --failures --since` on the dashboard's two report tabs, sharing their `windowView` toolbar with the landed role scope; done 2026-10-10 by feature)

**Goal.** `tumwater report --since <duration>` totals usage over a trailing window and
`tumwater report --failures --since <duration>` windows the failure digest the same way (both
capped at 7d). The dashboard's Usage and Failures views offer only whole-day counts
(7/14/30/90 and 7/14/30), so an operator cannot ask either tab for the last hour, 6 hours, or
day — the sub-day windows the CLI has. Add a trailing-window choice to both toolbars that
reads through the same `collectReportSince` / `collectFailureReportSince` collectors and reuses
the CLI's own Markdown render, so the browser and the terminal cannot disagree about the
window or its totals.

**Approach.**
1. `src/gui/gui-endpoints.ts`: import `collectReportSince` from `../report/report-data.js`,
   `renderSinceReportMarkdown` from `../report/report-render.js`, `collectFailureReportSince`
   from `../failure/failure-data.js`, and `REPORT_SINCE_MAX_MS` from `../events/event-window.js`.
   In `handleReport`, after the existing `role` validation, branch on `q.get("sinceMs") !== null`:
   a simultaneous `q.get("days") !== null` is the CLI's rival shape → 400 naming both; otherwise
   parse through the existing `intQuery(q, res, "sinceMs", "positive")` (null → return), reject a
   value above `REPORT_SINCE_MAX_MS` with a 400 naming the cap, and answer
   `{ markdown: renderSinceReportMarkdown(collectReportSince(root, sinceMs, role ?? undefined)) }`.
   The day path is unchanged (`collectReport` JSON). `handleFailures` gets the identical branch,
   answering `{ markdown: renderFailureMarkdown(collectFailureReportSince(root, sinceMs, role ?? undefined)) }`,
   and its day path stays `collectFailureReport` + `renderFailureMarkdown`.
2. `src/ui/gui/gui-client-report.ts`: give `viewHead` an optional trailing `sinceChoices`
   argument (an array of `[ms, label]`) and render one `<button type='button' data-since='<ms>'>`
   per entry into the existing `.seg` after the count buttons. In `windowView` add
   `let sinceMs = o.sinceChoices ? Number(recall(o.sinceKey)) || null : null;`, pass
   `o.sinceChoices` into `viewHead`, call `o.endpoint(days, role, sinceMs)`, and mark both
   controls on every fetch — `markActive($(o.pickerId), "days", sinceMs ? -1 : days)` and
   `markActive($(o.pickerId), "since", sinceMs || -1)` — so exactly one is active. `wireClicks`
   gains a `[data-since]` branch (`sinceMs = Number(b.dataset.since)`, `store(o.sinceKey, String(sinceMs))`,
   fetch) and its `[data-days]` branch clears a live since (`sinceMs = null`, `store(o.sinceKey, "")`)
   before persisting the count. Both configs gain
   `sinceChoices: [[3_600_000, "1h"], [21_600_000, "6h"], [86_400_000, "1d"]]` and
   `sinceKey: "usage-since"` / `"fail-since"`, and their `endpoint` takes `(days, role, sinceMs)`
   to build `/api/report?sinceMs=<ms>` (or `/api/failures?sinceMs=<ms>`) when set, the day
   `?days=` form otherwise, with the role suffix unchanged.
3. Usage's `render(d)`: when the payload carries `d.markdown` (the since shape), render it as
   `"<article class='card md'>" + renderMarkdown(String(d.markdown).replace(/^# .*\n+/, ""), true) + "</article>"`
   — the same markdown-card path Failures already uses, dropping the render's own `# …` heading
   since the view head titles the page — and otherwise keep today's `reportSummary` + chart
   render. Failures' render already handles `{ markdown }` and needs no change.
4. No new runtime dependency; the day-window path and both role scopes are untouched.

**Files touched.** `src/gui/gui-endpoints.ts`, `src/ui/gui/gui-client-report.ts`,
`test/gui-endpoints.test.ts`, `test/gui-report.test.ts`.

**Acceptance criteria.**
- `test/gui-endpoints.test.ts`: `handleReport` with `?sinceMs=3600000` answers 200
  `application/json` with a `markdown` field carrying no `series`/`days`, whose text includes
  `renderSinceReportMarkdown`'s `window: last 1h` line and counts a seeded `tick_end` 30 min old
  but not one 3 h old; `handleFailures` with `?sinceMs=3600000` answers `{ markdown }` whose first
  line is the failure digest's `window: last 1h`. `?sinceMs=604800001` (above the cap) and
  `?sinceMs=3600000&days=7` (rival shape) each answer 400; `?sinceMs=3600000&role=feature` scopes
  both collectors (only the feature tick counts, the digest names `feature`).
- `test/gui-report.test.ts`: with `recall("usage-since")` returning `"3600000"`, `fetchReport`
  requests `/api/report?sinceMs=3600000`, and a `{ markdown }` payload renders through
  `renderMarkdown` in the Usage body instead of the chart path; the built toolbar carries a
  `data-since` button that `markActive` marks while no `data-days` button is active. Choosing a
  `data-days` button builds a `?days=` request (asserted through the URL passed to the injected
  `getJson`).
- The existing day-window `handleReport`/`handleFailures` tests and the Usage chart and
  sparse-note tests stay green.
- `npm run test` is green.

### Role-scoped Usage and Failures panes in `tumwater tui`: the `Ctrl+G` scope cycle (planned 2026-10-10 by plan; independent of the waiting dashboard History trailing-window, dashboard report `--since`, and prompt `--edit --attach` plans; sibling of the landed "Role-scoped Usage and Failures views in the dashboard"; completes the landed `tumwater report --role <id>` / `tumwater report --failures --role <id>` scopes in the TUI's two report panes; done 2026-10-10 by feature)

**Goal.** `tumwater report --role <id>` and `tumwater report --failures --role <id>` scope the day report and failure digest to one loop, and the dashboard's Usage/Failures tabs have the same scope. The TUI's Usage and Failures panes still render fleet-wide and nothing in the pane can narrow them to the loop an operator is investigating, so the TUI is the one surface that cannot answer "what did this loop spend / how did it fail". Add one session-scoped role scope the operator cycles with a single key, applied to both panes through the collectors the CLI and dashboard already share.

**Approach.**
1. `src/ui/tui/tui-keys.ts`: add `let scopeRole: string | null = null` beside the `view` state, with a comment that it is session-only (the view/selection/scroll state is not persisted either), so a fresh TUI starts fleet-wide. Add the `Ctrl+G` branch, gated `!budgetMode && !rolePromptFor` like the other mode-sensitive keys: cycle `scopeRole` through `[null, ...roleIds]` (index-of-then-`+1`-mod-length), and when the current view is the Usage pane (`view === roleIds.length + 2`) or the Failures pane (`view === roleIds.length + 3`), recompute `paneCache` from the scoped collector (below) and reset `paneScroll = 0` so the changed body re-enters at its head; on any other view just set `scopeRole` (the Ctrl+T entry below computes with it). Always `deps.requestRender()`.
2. The Ctrl+T handler's two report branches change to `collectReport(root, REPORT_DEFAULT_DAYS, scopeRole ?? undefined)` and `collectFailureReport(root, REPORT_DEFAULT_DAYS, scopeRole ?? undefined)` — the same role parameter the CLI's `--role` and the dashboard tabs pass.
3. `syncSnapshot` resets `scopeRole` to null when it is not in the incoming `roles` roster (a retired/renamed loop must not leave the panes silently scoped to an absent role), joining the existing stale-`view` clamp; expose `scopeRole` on `TuiKeysState` and in `state()`.
4. `src/ui/tui/tui-frame.ts`: the `TuiView` `usage` and `failures` variants gain `scope: string | null`; `tabStrip` labels the active tab `Usage: <role>` / `Failures: <role>` and the plain `Usage` / `Failures` when the scope is null; `hintLine` for the usage/failures views gains a `["Ctrl+G", scope ? \`scope: ${scope}\` : "scope: fleet"]` pair after the scroll hint, so the key and the current scope are both on screen.
5. `src/ui/tui/tui.tsx`: build the two views as `{ kind: "usage", scope: s.scopeRole }` and `{ kind: "failures", scope: s.scopeRole }` from the state it already reads.
6. No new runtime dependency; the collectors, their Markdown renders, and the History/Pending panes are untouched.

**Files touched.** `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`, `test/tui-keys.test.ts`, `test/tui-frame.test.ts`.

**Acceptance criteria.**
- `test/tui-keys.test.ts`: with `syncSnapshot(0, false, ["feature", "clean"])` and one seeded `feature` `tick_end` (an error result with tokens, so it appears in both the usage report's totals and the failure digest's per-role table), Ctrl+G cycles `state().scopeRole` from `null` to `"feature"` to `"clean"` to `null`; on the Usage view each press recomputes `paneCache`, and the `clean`-scoped cache differs from the fleet-wide one; cycling to the Failures view under the same `clean` scope caches a digest whose text differs from the fleet-wide one; Ctrl+G leaves `scopeRole` unchanged while budget mode or role-prompt mode holds the prompt line; a later `syncSnapshot` whose roster drops the scoped role resets `scopeRole` to null.
- `test/tui-frame.test.ts`: `tabStrip({ kind: "usage", scope: "feature" }, width)` shows `Usage: feature` while `scope: null` shows `Usage`; `hintLine` for a usage or failures view carries the `Ctrl+G` hint, naming `scope: feature` under a scope and `scope: fleet` without one.
- `npm run test` is green.

### `tumwater prompt --edit ... --attach`: add images to a queued prompt in place (planned 2026-10-10 by plan; independent of the dashboard History and citation-sweep series; completes the landed `tumwater prompt --attach` enqueue form, whose doc-comment names the gap; done 2026-10-10 by feature)

**Goal.** `tumwater prompt --attach <path> <text>` queues a prompt with up to four images;
`tumwater prompt --edit <n> "<new text>"` rewrites a queued prompt in place and carries its
existing `[image attached: …]` references over, because `--edit` has no `--attach` form. An
operator who queued the wrong image (or none) must cancel and re-queue, losing the entry's
position and its pending `--at` deferral. Let `--edit` accept `--attach` too, saving the new
images beside the same queue file and appending their reference lines after the existing set,
so one command corrects the text and the images without moving the entry.

**Approach.**
1. `src/cli/cli-command-args.ts`: the edit variant gains `attachPaths: string[]`. `--attach`
   stays queue/edit-only: call `refuseQueueOnlyFlag("--attach", attachFlags.length > 0 && editFlag < 0)`
   so `--list`/`--cancel` keep the exact `--attach only queues a prompt` refusal while `--edit`
   passes. In the `editFlag` branch, claim `attachClaims` alongside `roleClaim` in both token
   scans (the stray-token loop before the position, and the replacement-text loop), so an attach
   pair is never replacement text, and return `attachPaths`.
2. `src/inbox/prompt-commands.ts`: factor the enqueue branch's `--attach` block (the
   `attachPathsProblem` pre-check, the per-path `fs.readFileSync` + base64, and
   `promptImagesProblem`) into one module-level helper `readPromptImages(paths): PromptImageInput[]`
   that fails through `fail`. The enqueue and edit branches both call it; the edit branch passes
   the result to `editRolePrompt`.
3. `src/inbox/inbox-edit.ts`: `editRolePrompt(root, role, position, newText, images?: PromptImageInput[])`.
   After reading the old file and its carried references, when `images` is non-empty: reject a
   combined count above `PROMPT_IMAGES_MAX_COUNT` with
   `promptImagesCountProblem(carried.length + images.length)`, save them with
   `savePromptImages(root, role, file, images)`, and append their `imageReferenceLines` after the
   carried ones. The composed length check (`promptLengthProblem`) then covers the body plus
   every reference line; on any throw after the save, `unlinkAllMissingTolerant` the newly saved
   paths so a failed edit strands no files — the same unwind `submitPromptWithImages` uses.
4. `src/inbox/inbox-attachments.ts` + `src/inbox/inbox.ts`: seed `savePromptImages`'s `taken`
   set from the same-stem image siblings already beside the queue file, so an edit that adds a
   `.png` to a prompt that already has one gets `-2` rather than overwriting the referenced file.
   Extract `inbox.ts`'s inline same-stem test in `removeSameStemSiblings` into an exported
   `isPromptImageSibling(stem, entry)` in `inbox-attachments.ts` and call it from both sites,
   single-homing the `<stem>.<ext>` / `<stem>-<n>.<ext>` shape.
5. `src/cli/help.ts` and `README.md`: name the `--edit … --attach` form beside the enqueue form.
6. No new runtime dependency.

**Files touched.** `src/cli/cli-command-args.ts`, `src/inbox/prompt-commands.ts`,
`src/inbox/inbox-edit.ts`, `src/inbox/inbox-attachments.ts`, `src/inbox/inbox.ts`,
`src/cli/help.ts`, `README.md`, and the tests named below.

**Acceptance criteria.**
- `test/cli-command-args.test.ts`: the `--edit` fixtures carry `attachPaths: []`; a new case
  parses `--edit 1 "new" --attach a.png` (and an `--attach` pair before `--edit`) to
  `{ mode: "edit", …, attachPaths: ["a.png"] }` with the attach pair absent from `text`;
  `--list`/`--cancel` still fail with `--attach only queues a prompt`.
- `test/inbox-edit.test.ts`: `editRolePrompt` with one image writes the new text plus the carried
  and new reference lines under the same queue file and deferral; a second same-extension image
  on a prompt that already has one lands as `<stem>-2.<ext>` while the existing file is
  byte-unchanged; a combined count over four throws before any save; an over-cap composed text
  throws and removes the just-saved image.
- `test/prompt-commands.test.ts`: `prompt --edit 2 --attach <png> "new text"` rewrites the
  entry and `--list` shows both reference lines; the queue keeps its position and stamp; a bad
  attach path fails by name with the queue untouched.
- `test/inbox-attachments.test.ts`: `savePromptImages` returns a non-colliding path when a
  same-stem image already exists.
- `npm run test` is green.

### A trailing window on the dashboard History view, matching `tumwater history --since` (planned 2026-10-10 by plan; sibling of the waiting "Search the dashboard History view with `tumwater history --grep`'s rule" plan — the two touch the same toolbar and fetch path and compose in either landing order; independent of the citation-sweep and invariant-register plans; done 2026-10-10 by feature)

**Goal.** `tumwater history --since <duration>` shows the completed ticks of a bounded trailing window, and marks a sparse window (one whose oldest retained event sits inside it) with the shared note. The dashboard's History view offers only a tick count, so an operator cannot ask "what happened in the last day" from the browser. Add a trailing-window choice to the toolbar that reads through the same `readTickRowsSince` collector the CLI uses, so the two views cannot disagree about the window's rows or its sparse-window warning.

**Approach.**
1. `src/gui/gui-endpoints.ts` `handleHistory`: read `role` as today, then branch on `q.get("sinceMs")`. Absent `sinceMs` leaves the `n` path unchanged (`{ rows }`). Present: a simultaneous `n` is a rival shape → 400 naming both, the CLI's count-vs-window rule; otherwise parse through `intQuery(q, res, "sinceMs", "positive")`, reject a value above `LOGS_SINCE_MAX_MS` (imported from `../events/event-window.js`, the same cap `history --since` uses) with a 400 naming the cap, and answer `{ rows, covered, note }` from `readTickRowsSince(root, sinceMs, role)` — add that import from `../history/history-data.js` — where `note` is `SPARSE_WINDOW_NOTE` (also from `event-window.ts`) when `!covered` and `""` otherwise. Reads files directly, like today.
2. `src/ui/gui/gui-client-history.ts`: inside the `history-table` region add `HIST_WINDOWS` (`{ "1h": [3_600_000, "the last hour"], "6h": [21_600_000, "the last 6 hours"], "1d": [86_400_000, "the last day"], "7d": [604_800_000, "the last 7 days"] }`) and a pure `historyQuery(count, role, sinceKey)` returning `/api/history?sinceMs=<ms>` (or `n=<count>` when no window) plus `&role=` when a role is set. Add the four options to the existing `#histcount` select after the counts; its value is `histSinceKey || String(histCount)`; choosing a window sets and persists a new `histSinceKey` (`recall("hist-since")`), choosing a count clears it and persists `hist-n` as today. `fetchHistory` calls `getJson(historyQuery(histCount, histRole, histSinceKey))` and keeps the server's `covered`/`note` in state, which `renderHistory` shows above the table when the note is non-empty.
3. The empty state names the active window (`No ticks in the last day`) instead of `No ticks yet`; this joins the sibling search plan's `No ticks match this search` rule, with a set search pattern winning over an empty window, so the note distinguishes "no rows exist in this window" from "rows exist but the search filtered them out".
4. No new runtime dependency.

**Files touched.** `src/gui/gui-endpoints.ts`, `src/ui/gui/gui-client-history.ts`, `test/gui-server-api.test.ts`, `test/gui-client-history.test.ts`.

**Acceptance criteria.**
- `test/gui-server-api.test.ts` extends the `/api/history` test: `?sinceMs=<wide>` returns the rows `readTickRowsSince(root, sinceMs, null)` yields with `covered: true` and `note: ""`; `?sinceMs=<tiny>` returns `{ rows: [], covered: true, note: "" }`; `?sinceMs=604800001` (above the cap) and `?sinceMs=3600000&n=20` each 400; `?sinceMs=<wide>&role=clean` returns only that loop's rows.
- `test/gui-client-history.test.ts` runs `historyQuery` through `clientScope` and asserts `sinceMs=` with no `n` in window mode, `n=` with no `sinceMs` otherwise, and `role=` only when set; and asserts the `#histcount` toolbar markup carries the four window options.
- The History view's empty state names the selected window, and the server's sparse note renders when `covered` is false.
- `npm run test` is green.

### Search the dashboard History view with `tumwater history --grep`'s rule (planned 2026-10-10 by plan; independent of the citation-sweep series; sibling of the landed `tumwater history --grep` and the landed role scope in the dashboard History view; done 2026-10-10 by feature)

**Goal.** `tumwater history --grep <text>` filters rows case-insensitively against a canonical
haystack (the row's own unpadded line prefixed with `tick_end`). The dashboard's History view
offers a loop picker and an outcome filter but no text search, so an operator cannot ask the same
substring question from the browser. Add a search field to the History toolbar that filters
through the same rule, with the predicate shared by the CLI and the endpoint rather than
re-implemented in the browser.

**Approach.**
1. `src/history/history-data.ts`: add and export `tickRowGrepHaystack(row: TickRow): string` — the
   canonical unpadded row line (`[row.time, row.loop, \`#${row.tick}\`, row.result,
   row.durationMs === null ? "—" : shortSpanPhrase(row.durationMs), row.usage, row.detail].join("  ").trimEnd()`)
   prefixed `tick_end `, the same string `src/history/history.ts`'s private `grepHaystack` builds
   today through `renderRow(row, widthsOf(cellsOf(row)))`. Import `shortSpanPhrase` from
   `../text/phrases.js` (history.ts already does).
2. `src/history/history.ts`: delete the private `grepHaystack` and have `cmdHistory` filter with
   `tickRowGrepHaystack`, so the CLI and the endpoint share one rule. No behavior change: the
   produced string is byte-identical (each cell padded to its own measured width is unpadded, and
   `cellsOf` already phrases the duration the same way).
3. `src/gui/gui-endpoints.ts` `handleHistory`: read `q.get("grep")`, and when it is non-empty
   filter the `readTickRows` result with the shared predicate lowercased, preserving the CLI rule
   that `n`/`role` bound the scanned rows and grep filters after them (`n` bounds the window, not
   the printed rows). An empty or absent `grep` filters nothing; `role` and `grep` compose.
4. `src/ui/gui/gui-client-history.ts`: add a search `<input id='histgrep'>` to the toolbar, with
   state `histGrep` recalled via `recall("hist-grep")` and persisted via `store`, and append
   `&grep=` (through `encodeURIComponent`) to the `/api/history` URL in `fetchHistory` only when
   non-empty; an Enter/`change` refetches. Pass `histGrep` to `historyTableHtml`, which shows
   `No ticks match this search` (instead of `No ticks yet`) when a pattern is set and the fetched
   rows are empty.

**Files touched.** `src/history/history-data.ts`, `src/history/history.ts`,
`src/gui/gui-endpoints.ts`, `src/ui/gui/gui-client-history.ts`, and the tests named below. No new
runtime dependency.

**Acceptance criteria.**
- `test/history-data.test.ts` pins `tickRowGrepHaystack` as the exact string a row renders as when
  it is the widest in each column (a null-duration row included, its em dash kept), and
  `test/cli-history-filtering.test.ts` still passes unchanged, proving the CLI's `--grep` output is
  untouched.
- `test/gui-server-api.test.ts` covers `/api/history?grep=<text>`: a pattern matching one seeded row
  returns only it; a pattern matching none returns `{ rows: [] }`; `role` and `grep` compose; `n`
  still bounds the scanned window before grep.
- `test/gui-client-history.test.ts` asserts the search input is in the toolbar, that `fetchHistory`
  appends the encoded `grep` only when set, and that a set pattern with no rows names the search
  rather than the empty log.
- `npm run test` is green.

### Keep the invariant register honest with a citation and id guard test (planned 2026-10-10 by plan; independent of the citation-sweep and Agent backends series; follow-up to the landed "An invariant register"; done 2026-10-10 by feature)

**Goal.** `docs/invariants.md` promises in its own "Keep it honest" paragraph that every invariant
has a stable id and a resolvable `test/...` citation, and that its `Binds.` modules are the ones the
guarantee spans — but nothing enforces any of that. A renamed test, a moved module, or a copied
entry slips through silently, turning the register the fleet reads into a stale citation. Add a test
that parses the register and fails on a broken citation, a duplicate/malformed id, or an entry
missing a field.

**Approach.**
1. Add a new test file, the invariants-doc guard, beside the other doc-parsing tests. Read the register through
   `fileURLToPath(new URL("../../docs/invariants.md", import.meta.url))` (the pattern
   `test/backlog-structure.test.ts` uses for `PLANS.md`), with the repo root as
   `fileURLToPath(new URL("../../", import.meta.url))`.
2. Parse with a small helper local to the test: split the text at `^### (INV-[A-Z]\d+):`, and per
   entry record its id, whether it carries the `**Guarantee.**`, `**Binds.**`, and `**Pinned by.**`
   field labels, and every backticked path token matching `/(?:src|test|docs|plans|scripts)\//`.
3. Assert, so the guard names the failure rather than only a count:
   - the register holds at least one entry, and ids are unique and match `/^INV-[A-Z]\d+$/`;
   - every entry has all three field labels and its `**Pinned by.**` cites at least one
     `test/*.test.ts` path;
   - every cited path resolves under the repo root (skip the prose placeholders — the bare
     `test/...` / `src/...` ellipses and any glob token — so only real citations are checked);
   - the two `test/...` and `src/...` paths cited by each entry exist.
4. Tests only; no `src/` change, no runtime dependency, no new pipeline step.

**Files touched.** One new test file under `test/` (the invariants-doc guard). No source change.

**Acceptance criteria.**
- `npm test invariants` is green, and the new file fails if a cited `test/...` or `src/...` path is
  removed, if two entries share an id, or if an entry loses a field label (verified by temporarily
  breaking the doc and watching the guard fail).
- `docs/invariants.md` is unchanged by this landing and still parses under the new guard.
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 5f/5: `parallel-work-instances`, `worktree-pool` (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 5/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/parallel-work-instances.md` and
`plans/worktree-pool.md`. Both are inventoried over their full text so a path or line pin that
moved is caught rather than missed.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to these two files.

**Files touched.** Those two `plans/*.md` files. No source or test change.

**Acceptance criteria.**
- The inventory over these two files reports no cited path absent from the tree.
- No `<path>:<line>` in them names a line past that file's end.
- For each split module cited here, the module named beside a symbol exports it (checked against
  the module's export list).
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 5e/5: `telemetry-role`, `disk-floor` (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 5/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/telemetry-role.md` and
`plans/disk-floor.md`. `plans/telemetry-role.md` carries the most absent tokens left in the
sweep — the `failure-report` module split across its root and UI homes and its test file, the
moved top-level `loop`, `config`, and `state` modules, and two out-of-range `src/roles/roles.ts`
pins.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to these two files.

**Files touched.** Those two `plans/*.md` files. No source or test change.

**Acceptance criteria.**
- The inventory over these two files reports no cited path absent from the tree.
- No `<path>:<line>` in them names a line past that file's end.
- For each split module cited here, the module named beside a symbol exports it (checked against
  the module's export list).
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 5c/5: `refusal-and-thrash`, `merge-queue`, `work-ratio` (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 5/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/refusal-and-thrash.md`,
`plans/merge-queue.md`, and `plans/work-ratio.md`. `plans/refusal-and-thrash.md` carries the bulk
here: the same moved top-level `pi-stream`, `loop`, `git`, `pi`, `types`, and `config` modules.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to these three files.

**Files touched.** Those three `plans/*.md` files. No source or test change.

**Acceptance criteria.**
- The inventory over these three files reports no cited path absent from the tree.
- No `<path>:<line>` in them names a line past that file's end.
- For each split module cited here, the module named beside a symbol exports it (checked against
  the module's export list).
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 5d/5: `repair-traces`, `revise-rejected` (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 5/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/repair-traces.md` and
`plans/revise-rejected.md`. `plans/repair-traces.md` carries the moved top-level `loop` module and
two out-of-range pins (`src/roles/roles.ts`, `test/prompt.test.ts`); `plans/revise-rejected.md` is
inventoried as well so a later move there is caught.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to these two files.

**Files touched.** Those two `plans/*.md` files. No source or test change.

**Acceptance criteria.**
- The inventory over these two files reports no cited path absent from the tree.
- No `<path>:<line>` in them names a line past that file's end.
- For each split module cited here, the module named beside a symbol exports it (checked against
  the module's export list).
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 5a/5: `plans/agent-backends.md` (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 5/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/agent-backends.md` — the largest
remaining document. Its path tokens all resolve today, but its citations predate the pi-facade,
config, and agent splits, so the split-aware symbol check carries the work.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5.

**Files touched.** `plans/agent-backends.md`. No source or test change.

**Acceptance criteria.**
- The inventory over `plans/agent-backends.md` reports no cited path absent from the tree.
- No `<path>:<line>` in it names a line past that file's end.
- For each split module cited there (e.g. `src/pi/pi.ts`, `src/config/model-selector.ts`), the
  module named beside a symbol exports it (checked against the module's export list).
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 5b/5: `commit-bodies`, `refusal-and-thrash`, `user-defined-loops`, `principles` (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 5/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/commit-bodies.md`,
`plans/refusal-and-thrash.md`, `plans/user-defined-loops.md`, and `plans/principles.md`. The
inventory here flags the moved top-level `loop`, `pi`, `types`, `config`, `git`, and `pi-stream`
modules, plus the moved `commit-bodies` test file cited by `plans/commit-bodies.md`.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to these four files.

**Files touched.** Those four `plans/*.md` files. No source or test change.

**Acceptance criteria.**
- The inventory over these four files reports no cited path absent from the tree.
- No `<path>:<line>` in them names a line past that file's end.
- For each split module cited here, the module named beside a symbol exports it (checked against
  the module's export list).
- `npm run test` is green.

### Role-scoped Usage and Failures views in the dashboard (planned 2026-10-10 by plan; independent of the Agent backends series; sibling of the landed `tumwater report --role <id>` and `tumwater report --failures --role <id>`; completes the CLI's role scope on the dashboard's two report tabs; done 2026-10-10 by feature)

**Goal.** The dashboard's Usage and Failures views gain a loop picker, and `/api/report` and
`/api/failures` accept a `?role=<id>` scope, so an operator can see one loop's spend and one
loop group's failure evidence in the browser without dropping to `tumwater report --role`. The
CLI already scopes both shapes (`report --role`, `report --failures --role`) and the collectors
already take the optional base role (`collectReport(root, days, role?)`,
`collectFailureReport(root, days, role?)`); only the dashboard's endpoint adaptation and its
two views are missing. Out of scope: the TUI's Usage/Failures panes (a separate surface, left
for a later sibling), and any change to the collectors or the CLI.

**Approach.**
1. **Endpoints.** In src/gui/gui-endpoints.ts, `handleReport` and `handleFailures` read
   `const role = q.get("role")` and, when present (`!== null`), validate it through the
   existing `rejectBadRole(root, res, role)` (gui-args.ts) before collecting — absent means the
   fleet-wide report exactly as today, `?role=bogus` gets the shared unknown-role 400 with its
   typo hint, and `?role=` (empty) is a present-but-unknown 400. Then pass `role ?? undefined`
   as the collectors' third argument. No new gui-args helper is needed.
2. **Role picker in the shared view scaffold.** In src/ui/gui/gui-client-report.ts,
   `windowView(o)` gains an optional role scope: a `let role = recall(o.roleKey) || ""`, a
   `rolePickerId`, and an `endpoint(days, role)` that appends `&role=` + encodeURIComponent(role)
   only when `role` is non-empty. `viewHead` gains the picker markup, reusing the History view's
   shape (src/ui/gui/gui-client-history.ts's `#histrole`):
   `<label><span class='sr-only'>Loop</span><select class='field' id='<rolePickerId>'>…</select></label>`
   with an `All loops` empty option. `syncReportRoles(d)` (new, in a `// report-role:start/end`
   region) derives the option list from `(d.loops || []).map((l) => l.role)` — the same list
   `syncHistoryRoles` uses — and is called from `fetchView` after the panel is built and from
   gui-client-boot.ts's status refresh when `activeView` is `"usage"` or `"failures"` (mirroring
   the existing `if (activeView === "history") syncHistoryRoles(d);`). `wireClicks` gains a
   `change` delegate on the panel for `[data-role]` selects that stores the choice
   (`store(o.roleKey, role)`) and refetches. The pure option builder is a separately extracted
   function (e.g. `reportRoleOptions(roles)` returning the `<option>` inner HTML) so it is
   unit-testable without a DOM.
3. **Wire the two views.** The `usage` and `failures` `windowView` calls set the role config and
   the scoped endpoint; the Usage blurb keeps its wording for the fleet-wide case.
4. **Scoped Usage render.** `reportSummary(d)` must not show the fleet-only fleet-wide backlog
   tallies as the scoped role's: when `d.role` is set, drop the `Features done` and `Bugs fixed`
   tiles and, in the `render` output, print one scope line naming `d.role` and stating that
   landing runs and backlog tallies are fleet-wide and omitted. The Failures view needs no
   render change: `renderFailureMarkdown` already emits its `role:` line for a scoped digest.

**Files touched.**
- src/gui/gui-endpoints.ts (`handleReport`, `handleFailures`: read + validate `?role=`, pass it)
- src/ui/gui/gui-client-report.ts (`windowView` role config, `viewHead` picker,
  `reportRoleOptions`, `syncReportRoles`, `wireClicks` change delegate, `reportSummary` scope,
  usage/failures endpoints)
- src/ui/gui/gui-client-boot.ts (sync on status refresh while a report view is open)

Tests: test/gui-report.test.ts — `/api/report?role=feature` deep-equals
`collectReport(repo, 14, "feature")`, `/api/failures?role=feature` equals
`renderFailureMarkdown(collectFailureReport(repo, 14, "feature"))`, `?role=bogus` is a 400 naming
the valid ids, and the page-level endpoint regexes are updated to the role-aware form;
test/gui-client-report.test.ts — a new `report-role` extraction test over `reportRoleOptions`
(the `All loops` empty option, one escaped option per loop, order preserved; a role name with
HTML metacharacters is escaped).

**Acceptance criteria.**
- `/api/report?role=feature&days=14` and `/api/report?role=feature` serve
  `collectReport(root, days, "feature")` — `role: "feature"`, only feature per-role maps,
  zero `featuresDone`/`bugsFixed`; without `?role` the payload is unchanged (seen by the
existing deep-equal against `collectReport(repo, 14)`).
- `/api/failures?role=feature` serves `renderFailureMarkdown(collectFailureReport(root, days,
  "feature"))` and its markdown carries the `role: feature` line; without `?role` it is
  unchanged.
- `?role=bogus` on either endpoint is a 400 whose message names the valid ids; `?role=` is a
  400 too; the days window still clamps exactly as today regardless of `role`.
- The Usage and Failures views render a `Loop` select with `All loops` plus one option per
  `lastStatus.loops[].role`; choosing one refetches with `&role=`, persists through `store`, and
  the Usage summary then omits the `Features done`/`Bugs fixed` tiles and prints the scope line;
  choosing `All loops` returns to the fleet-wide view.
- The options follow the fleet's role list (custom loops included), refreshed while the view is
  open, and a persisted role the fleet no longer lists falls back to `All loops`.
- `npm run test` is green.

### Agent backends, part 7b/7: the claude tool-call stall threshold (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 7/7, which feature judged too large for one run; requires parts 6a/7 and 6b/7 landed; siblings 7a/7 and 7c/7; independent of the citation-sweep series; done 2026-10-10 by feature)

Design: plans/agent-backends.md "Watchdogs and progress". Sibling 7a/7 wires the API cap and
its handback; this part touches neither budget nor argv.

**Goal.** A claude tool call that sends no content update is judged stalled at
`bufferedCommandStallMs`, not `toolCallStallSeconds`, so long verification commands stop crying
wolf (BUGS.md 2026-09-28's lesson); pi keeps today's per-command classification.

**Approach.** The run's backend is already known on both surfaces: runAgent holds `backend.id`
(src/agent/run-agent.ts) and the `tumwater_run` marker carries `agent`, which
src/ui/progress-data.ts reads into `LiveProgress` (`agent?: string`).
- The claude stream must actually expose the call while the tool runs:
`claudeTranslator` (src/agent/claude/claude-stream.ts) now emits a canonical
`tool_execution_start` the moment a `tool_use` block is folded, not at the later `tool_result`
(the two previously arrived together, so no open-call tracker ever saw a claude call).
- runPi's warning: `startPiWatchdogs` (src/pi/pi-watchdogs.ts) — its openToolCalls loop currently
calls `commandBuffersOutput(call.command || call.label)` to pick the buffered threshold. The
deps carry the run's backend id; when it is `"claude"`, every open call takes the
`bufferedCommandStallMs` branch.
- progress-data's flag: `stalledToolLabel` (src/ui/progress-data.ts) does the same classification
for the role's state cell; it reads the current run's `agent` off `LiveProgress` (set from the
marker, preserved across the run's `session` reset, defaulting to pi when no marker precedes the
run) and applies the same rule, so the state cell and the event feed agree on "stalled".

**Files touched.** src/pi/pi-watchdogs.ts, src/ui/progress-data.ts, src/agent/run-agent.ts (feed
the backend id), src/agent/claude/claude-stream.ts (open the call at the `tool_use` block).
Tests: test/pi.test.ts, test/progress.test.ts, test/claude-stream.test.ts.

**Acceptance criteria.**
- A claude Bash call open longer than `toolCallStallSeconds` but shorter than
`bufferedCommandStallMs` raises no stall warning on either surface.
- The same call open past `bufferedCommandStallMs` raises the stall warning on both surfaces.
- A pi non-buffered call still warns at `toolCallStallSeconds`.
- `npm run test` green.

### An invariant register: state each subsystem's guarantees where a fixer can read them (planned 2026-10-10 by steward; promoted from the `unclear-invariant` validation gap, carried by 92 Fixed entries — the largest gap tag and mostly in entries still kept verbatim; independent of the Agent backends and citation-sweep series; done 2026-10-10 by feature)

**Goal.** Retire the `unclear-invariant` gap. It is recorded when a fixer could not confirm a bug
until first reconstructing what the code was supposed to guarantee; today that guarantee lives only
in scattered tests and the fixer's head, so each entry spent effort rediscovering it. Give the
project one place that states its invariants, and point the loops at it before they reconstruct one.

**Evidence.** `unclear-invariant` is the top validation-gap tag by a wide margin — 92 Fixed entries
carry it versus 58 for the next non-`none` tag (`no-observability`) — and unlike the historical tags it is not
mostly compressed: 78 of the 92 are entries still kept verbatim in `## Fixed`. (`grep -oE
'gap:[*]{0,2} ?[a-z-]+' BUGS.md | sed -E 's/^gap:[*]{0,2} ?//' | sort | uniq -c` counts both forms.)
The recurring families, each visible in the cited entries:
- **Two surfaces deriving one fact separately** — the dashboards' stall flag versus the event feed's
  warning ("The dashboards' stall flag never got the piped-stdout exemption…", fixed 2026-09-28),
  the `status` header badge versus the event log's window contract ("The status header's `main
  <sha>: green` badge reads only the default 200-event tail…", fixed 2026-09-29), doctor's binary
  check versus the startup gate's `agentsInUse` ("`checkAgentBinary` always checks pi…", fixed
  2026-10-10), and a kept free tier versus its pre-cap resolution ("The budget-fallback view's kept
  free subscription claude tier dropped the ambient thinking level from its selector…", fixed
  2026-10-10).
- **A reader and writer over one appended or persisted file** that must agree on its end — the
  trailing-fragment window fold, and `slots.json`'s non-finite-timestamp boundary ("`slots.json`'s
  `pinnedAt` and `lastReleasedAt` carried a hand edit's non-finite timestamps…", fixed 2026-10-09).
- **Sibling result shapes a classifier must treat alike** — the loss ranking's `main_red`, `aborted`,
  `review_error`, and `merge_conflict` arms ("The failure digest's loss ranking drops the
  error-class hours a `merge_conflict`/`merge_blocked` landing reprices…", fixed 2026-10-10).
Seed the register from these families, and add sections as new ones recur.

**Approach.**
1. Add a new invariants register under `docs/`: grouped by the boundary an invariant binds. Each entry gets a
   stable id, a one-sentence guarantee, the modules and surfaces it binds, and the `test/...`
   case(s) that pin it. Start from the three families above, seeded from the cited Fixed entries.
2. Point the loops at it. The role prompt already injects `PRINCIPLES.md` through `readPrinciples`
   (src/prompt/principles.ts); name the register there as the place a fixer reads its
   subsystem's guarantees before reconstructing one, so the reference costs a line of prefill rather
   than inlining the whole register.
3. Keep it honest. A landing that adds or changes a guarantee updates the register in the same
   commit; each invariant cites the test that pins it, so a stale invariant is a visible broken
   citation rather than silent drift.
4. No new runtime dependency and no change to the loop pipeline.

**Files touched.** a new invariants register under `docs/`; the role prompt text (src/prompt/principles.ts or the
prompt builder) to name it; the `test/...` cases it cites are unchanged. Doc-only otherwise.

**Acceptance criteria.**
- The register states at least the three boundary families above, each with a stable id, the
  modules/surfaces it binds, and a resolvable `test/...` citation.
- Every `test/...` path the register cites exists and pins the invariant it is cited for.
- The role prompt names the register without inlining it; `PRINCIPLES_MAX_CHARS` is unaffected.
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 3/5: the budget and model plan documents (planned 2026-10-10 by plan; split 2026-10-10 by plan from the single-entry sweep; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for the plan documents that cite the config
and model splits: `plans/daily-cost-budget.md`, `plans/fallback-model.md`, and
`plans/model-tiers.md`.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to these three files. Their absent paths are the `types`, `config`, `loop`,
`orchestrator`, `pi`, `state`, and `status` module moves, so the split-aware map is exercised
across several owners.

**Files touched.** Those three `plans/*.md` files. No source or test change.

**Acceptance criteria.**
- The inventory over these three files reports no cited path absent from the tree.
- No `<path>:<line>` in these three files names a line past that file's end.
- For each split module cited here, the module named beside a symbol exports it (checked against
  the module's export list).
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 4/5: the observer, QA, questions, review, and steward plan documents (planned 2026-10-10 by plan; split 2026-10-10 by plan from the single-entry sweep; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/observer-roles.md`,
`plans/qa-role.md`, `plans/questions-outbox.md`, `plans/review-gate.md`, and
`plans/steward-role.md`.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to these five files. Their absent paths are the `loop`, `types`, `config`,
`orchestrator`, `state`, `questions`, and `status-render` module moves, and
`plans/observer-roles.md` also carries one out-of-range pin.

**Files touched.** Those five `plans/*.md` files. No source or test change.

**Acceptance criteria.**
- The inventory over these five files reports no cited path absent from the tree.
- No `<path>:<line>` in these five files names a line past that file's end.
- For each split module cited here, the module named beside a symbol exports it (checked against
  the module's export list).
- `npm run test` is green.

### Agent backends, part 7c/7: the opt-in `smoke:claude` live check (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 7/7, which feature judged too large for one run; requires parts 6a/7 and 6b/7 landed; siblings 7a/7 and 7b/7; independent of the citation-sweep series; done 2026-10-10 by feature)

Design: plans/agent-backends.md "Testing". Siblings 7a/7 and 7b/7 cover the cap and the stall
threshold; this part is the live check only and changes no production path.

**Goal.** A machine with a logged-in claude can run one opt-in command that exercises the live
CLI end to end, so a regression the fake shim cannot see fails here by hand and not in the fleet.

**Approach.** Add a new `smoke-claude` Node ESM script under `scripts/` (no dependencies) and a
`"smoke:claude"` entry in package.json that runs it. The script builds a
throwaway git repo under `fs.mkdtemp` and drives the real `claude` on PATH, printing a named
PASS/FAIL per check and exiting nonzero on the first failure:
- one call on each default model (Haiku, Sonnet, Opus 5.5), so a CLI too old for one fails here;
- an isolated three-turn run that fails if total cost exceeds $0.10 (the isolation regression);
- a `--resume` of that session;
- a SIGTERM mid-tool call followed by a resume;
- an unknown-model run that must classify as `configError`;
- a check that the observed `billing` matches `claude auth status`, and that
`claude-account.json` gained a window reading when the billing is subscription.
It must not run under `npm test` (it costs money and needs auth): keep the script's own env
setup, and leave `test-runner.ts`'s `TUMWATER_CLAUDE_BIN`/`CLAUDECODE`/`CLAUDE_CODE_*` stripping
as is. Document it in README.md as opt-in.

**Files touched.** a new `smoke-claude` script under `scripts/`, package.json, README.md.

**Acceptance criteria.**
- `npm run smoke:claude` is defined and is referenced nowhere in the `npm test` path; `npm run
test` stays green on a machine with no claude installed.
- Each check prints a named PASS/FAIL and the script exits nonzero on failure.
- On a logged-in machine the script passes; run it once by hand and record the result in the
landing commit body.
- `npm run test` green.

**Landed.** `scripts/smoke-claude.mjs` drives the real CLI through the compiled adapter
(`runAgent`), with a version floor check added before the model calls. The isolation check
prompts for three Bash calls and asserts `costUsd < 0.10` and `turns >= 2` (the second turn is
where the regression loaded `~/.claude`); it ran green by hand against claude 2.1.295 on a
claude.ai subscription. The account check folds the run through `observeClaudeAccount` and
reads the window back.

### Finish the stale code-path citation sweep, part 2c/5: `plans/portability.md`, part 7/7 (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 2/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/portability.md`'s "7/7 — Adopt an
existing repository without hijacking its README" section.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to this section. It cites the config and merge splits, so the split-aware map
and its per-citation symbol check carry most of the work.

**Files touched.** `plans/portability.md` (only the named section). No source or test change.

**Acceptance criteria.**
- The inventory over the named section reports no cited path absent from the tree.
- No `<path>:<line>` in the named section names a line past that file's end.
- For each split module cited in the named section, the module named beside a symbol exports it
  (checked against the module's export list).
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 2b/5: `plans/portability.md`, part 6/7 (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 2/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/portability.md`'s "6/7 — Make the
project's verification command configurable" section.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to this section. This is the densest source of line pins past a file's end in
the sweep, so the inventory step carries most of the work.

**Files touched.** `plans/portability.md` (only the named section). No source or test change.

**Acceptance criteria.**
- The inventory over the named section reports no cited path absent from the tree.
- No `<path>:<line>` in the named section names a line past that file's end.
- For each split module cited in the named section, the module named beside a symbol exports it
  (checked against the module's export list).
- `npm run test` is green.

### Agent backends, part 7a/7: API per-run cap and the `budgetCapped` handback (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 7/7, which feature judged too large for one run; requires parts 6a/7 and 6b/7 landed; siblings 7b/7 and 7c/7; independent of the citation-sweep series; done 2026-10-10 by feature)

Design: plans/agent-backends.md "Billing" (API runs) and §10. Siblings: 7b/7 wires the claude
stall threshold, 7c/7 adds the opt-in smoke script; this part touches neither.

**Goal.** An API-billed, non-director claude run can never overshoot the daily cap, and a run
cut off by `error_max_budget_usd` keeps its worktree and resumes as a `handoff`.

**Approach.**
- Thread the cap to the argv. `ClaudeArgOptions.maxBudgetUsd` and the `--max-budget-usd` builder
already exist in src/agent/claude/claude-args.ts; the missing links are the carrier and the
caller. Add an optional `maxBudgetUsd` to `PiRunOptions` (src/pi/pi.ts) and to `AgentRunSpec`
(src/agent/agent-backend.ts), and have `claudeBackend.invocation`
(src/agent/claude/claude-backend.ts) forward it. Compute the value in the authoring-call wiring
that already holds `root`, the role, and the live loop states — `LoopPi.loopPiOpts`
(src/loop/loop-pi.ts) fed from the tick wiring (src/loop/loop-tick.ts) — using
`readClaudeAccount(root)` (src/agent/claude/claude-account.ts) and `fleetDailyCost` / `dailyCost`
(src/budget/budget.ts). Pass a cap only when the resolved backend is claude and the account
reports `billing: "api"`; it is `maxDailyCostUsd − fleetDailyCost`, lowered to the role's
remaining `maxDailyCostUsdPerRole[role] − dailyCost(roleState)` when that key is set. The
director (`DIRECTOR_ROLE`) and subscription-billed runs pass none.
- Handle the cap hit. `PiRunResult.budgetCapped` is already set by the claude translator
(src/agent/claude/claude-stream.ts, `error_max_budget_usd`). Nothing consumes it today. On an
authoring result with `budgetCapped`, keep the worktree and set `state.resumePending` with a new
`resumeCause` (e.g. `"budget-capped"`) added beside the existing union in
src/loop/loop-state.ts and src/tick/tick-outcome.ts. `planTickStart` (src/tick/tick-resume.ts)
only considers a handoff when `resumePending` is set, so this is what makes the next tick resume
rather than reset the worktree; the handoff then gets the revision/conflict notes, no re-apply,
the leased slot, and the same loop id, exactly as the part 3/7 handoffs do. The existing
`budget-resumed` cause (src/loop/loop-recovery.ts, the mid-tick budget reopen) is unchanged; the
bridge prompt names the new cause distinctly.
- A run with no `result` records cost 0 and logs `cost_unknown`: confirm the translator/run-agent
already emit it (parts 3 and 6a) and add only the missing wiring if a gap is found — do not
rewrite it.

**Files touched.** src/pi/pi.ts, src/agent/agent-backend.ts,
src/agent/claude/claude-backend.ts, src/loop/loop-pi.ts, src/loop/loop-tick.ts,
src/loop/loop-state.ts, src/tick/tick-outcome.ts, src/tick/tick-resume.ts. Tests:
test/claude-args.test.ts and a loop test for `budgetCapped` → handoff.

**Acceptance criteria.**
- On API billing, with $12 of a $15 fleet cap spent and no per-role cap, an authoring claude
run's argv carries `--max-budget-usd 3`; a subscription-billed run's and the director's argv
carry no `--max-budget-usd`.
- With `maxDailyCostUsdPerRole[role] = 2` and $1.50 of the role's spend, the argv carries
`--max-budget-usd 0.5` (the role's remaining is lower than the fleet's remaining).
- A `budgetCapped` authoring result sets `resumePending` and leaves the worktree edits in place;
the next tick runs as `handoff` with the budget-capped cause.
- `npm run test` green.

**Landed 2026-10-10 by feature.** `PiRunOptions` lives in src/agent/run-agent.ts (src/pi/pi.ts
re-exports the type), and the budget-capped verdict arm is in src/tick/tick-verdict.ts rather
than the plan-named src/loop/loop-tick.ts; the cap is computed in `LoopPi.loopPiOpts` from
the persisted loop states, and the forced handoff lives in src/tick/tick-resume.ts. The per-role cap is keyed by BASE role
(`baseRoleOf`) and sums the instance group's spend, matching the scheduler gate's
`roleCapVerdicts` (src/gates/role-cap-gates.ts) and the base-role keys config validation
enforces; the plan's `maxDailyCostUsdPerRole[role]` shorthand means that base-role key.

### Finish the stale code-path citation sweep, part 2a/5: `plans/portability.md`, part 5/7 (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 2/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/portability.md`'s "5/7 — Make the
agent binary configurable" section.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to this section. Its prose is a dense source of line pins past a file's end.

**Files touched.** `plans/portability.md` (only the named section). No source or test change.

**Acceptance criteria.**
- The inventory over the named section reports no cited path absent from the tree.
- No `<path>:<line>` in the named section names a line past that file's end.
- For each split module cited in the named section, the module named beside a symbol exports it
  (checked against the module's export list).
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 1c/5: `plans/portability.md`, parts 4a/7–4c/7 (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 1/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/portability.md`'s "4a/7 — Seed an
untracked config from a tracked template", "4b/7 — Untrack this repo's own config without
deleting it", and "4c/7 — Move README's rig notes into docs/backends.md" sections.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to these sections.

**Files touched.** `plans/portability.md` (only the named sections). No source or test change.

**Acceptance criteria.**
- The inventory over the named sections reports no cited path absent from the tree.
- No `<path>:<line>` in the named sections names a line past that file's end.
- For each split module cited in the named sections, the module named beside a symbol exports it
  (checked against the module's export list).
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 1a/5: `plans/portability.md`, parts 1/7–2/7 (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 1/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** Every path-shaped token in this part's plan-document sections names a path that exists
in the tree, every `<path>:<line>` names a line the file actually has, and a module that has
since split names the module that owns the symbol beside the citation. A reader who follows the
citation reaches the code it describes. The plans were audited before the landing, pi-facade,
config, loop, and events splits, so today a citation names a module that no longer exists or a
line past the file's end; the 2026-10-10 review of `plans/portability.md` named three remaining
classes — a helper pinned to the wrong landing module, a build-scope call pinned to a stale
module, and line pins past the file's end.

**Scope.** `plans/portability.md` sections "1/7 — GitHub Actions CI and a publishable npm
package" and "2/7 — Resolve the repo root, and target any branch". Disjoint from the other
citation-sweep parts, so the parts land cleanly in any order.

**Method (the other citation-sweep parts apply this same four-step method to their own scope).**
1. Inventory: scan the scope for path-shaped tokens and keep the ones whose path is absent from
   the tree; separately list every `<path>:<line>` whose line is past the file's end. A clean
   inventory over the scope is the acceptance check.
2. Split-aware map: for each moved module, name the one current module that owns the cited
   symbol — the root modules that moved into their own directory keep their file name, so
   `src/config/config.ts`, `src/loop/loop.ts`, `src/pi/pi.ts`, `src/git/git.ts`,
   `src/orchestrator/orchestrator.ts`, and `src/config/config-validation.ts` are the owners,
   while the `types`, `state`, and `merge` modules split into per-topic files — but a module
   that split into a facade plus
   implementations needs a per-citation symbol check, never a blanket rename. `git log
   --diff-filter=R --name-status` and `grep -rn <symbol> src` locate the owner.
3. Rewrite rule: replace the path with its current module and drop the old `:line` pin, keeping
   the symbol name in the surrounding prose. A path alone is honest; a stale number is not.
4. Historical audits: a dated "Verified as written" paragraph is a snapshot at the commit its
   heading names. Keep that commit reference; reword its line pins to symbol names rather than
   asserting a current line.

**Files touched.** `plans/portability.md` (only the named sections). No source or test change.

**Acceptance criteria.**
- The inventory over the named sections reports no cited path absent from the tree.
- No `<path>:<line>` in the named sections names a line past that file's end.
- For each split module cited in the named sections, the module named beside a symbol exports it
  (checked against the module's export list).
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 1b/5: `plans/portability.md`, part 3/7 (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 1/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/portability.md`'s "3/7 —
Harness-mediated config writes: take custom loops off the commit path" section.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to this section.

**Files touched.** `plans/portability.md` (only the named section). No source or test change.

**Acceptance criteria.**
- The inventory over the named section reports no cited path absent from the tree.
- No `<path>:<line>` in the named section names a line past that file's end.
- For each split module cited in the named section, the module named beside a symbol exports it
  (checked against the module's export list).
- `npm run test` is green.

### Agent backends, part 6e/7: resume across a usage-window hold (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 6/7; requires part 6c/7 landed; done 2026-10-10 by feature)

Design: plans/agent-backends.md ("The subscription usage window", "Sessions"). The entry's
"Interactions (resume across a usage-window hold)" heading does not exist in the document; the
behavior is stated in §8 and §4.

Goal: a subscription claude run cut off by a rejected window keeps its worktree and resumes with
the same session id after `resetsAt`, instead of a fresh tick resetting the worktree and losing
its edits. Depends on 6c's hold.

**Approach.**
1. **Resume state.** The rate-limit end's outcome sets `state.resumePending` (src/tick/
   tick-verdict.ts sets it inline in the `error` arm, before `applyTickOutcome`; src/tick/
   tick-apply.ts's `applyTickOutcome` sets it too), so src/tick/tick-resume.ts's
   `planTickStart` treats the next run as a resume rather than a fresh tick. Because
   src/loop/loop-tick.ts's `runTickInLeasePhase` reads `resumePending` in its `finally`,
   before `applyTickOutcome` runs, the inline arming is what keeps the leased slot pinned
   and the worktree edits intact. `resolveTickVerdict` detects the rejected window through
   the shared `subscriptionWindowRejected` predicate (src/agent/claude/claude-account.ts) and
   returns an `error` outcome carrying `resumeCause: "rate-limit"`. The check sits before
   staging, so a dirty, content-bearing run no longer commits its half-done edits.
2. **Resume, not handoff.** After `resetsAt`, the run resumes with `--resume <same id>` through
   src/loop/loop-tick.ts; it is not a handoff, because the agent did not change and 6b never
   moves subscription seams to the fallback. The named `rate-limit` cause gives the resume bridge
   its own wording (src/prompt/prompt-followup.ts); nothing re-applies a note.
3. **No wasted within-run retry.** src/loop/loop-pi.ts's transient retry skips a subscription
   window rejection: the retry's bounded wait cannot outlast the window, and the fleet hold
   already defers the tick.
4. **Overage and API billing.** When overage or API billing does move a seam to its fallback,
   the 4/7 handoff rules apply unchanged; `subscriptionWindowRejected` reads false for an
   API-billed or overage run, so those keep the existing paths.

**Files touched.** src/agent/claude/claude-account.ts, src/tick/tick-verdict.ts,
src/tick/tick-apply.ts, src/tick/tick-outcome.ts, src/loop/loop-state.ts,
src/loop/loop-tick.ts, src/prompt/prompt-followup.ts, src/loop/loop-pi.ts.

**Tests.** Cases in test/tick-resume.test.ts (the rejected-window verdict, the lease pin
condition `slotPinnedForResume` evaluated on the post-verdict state, and the next tick's
resume) and test/loop-pi-claude.test.ts (no within-run retry), both using fake-claude.

**Acceptance criteria.**
- An interrupted fake-claude author tick, a hold, then a reset produces one resume with the same
  session id, with the worktree edits intact.
- The resume's cause is named (not a plain fresh tick).
- `npm run test` green.

### Agent backends, part 6d/7: the usage-window display (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 6/7; requires parts 6a/7 and 6c/7 landed; done 2026-10-10 by feature)

Design: plans/agent-backends.md ("Display, in place of the daily spend").

Goal: the TUI, GUI, `tumwater status` and `tumwater role <id>` show the subscription window in
place of (or alongside) the daily spend. The "held until" wording is derived from the account's
rejected window (the same predicate fleet-hold.ts uses), so no separate held-state read is
needed.

**Approach.**
1. **Status payload.** src/status/status-data.ts gains a `claudeWindow` block (the most
   constrained window plus the full list, `only` classifying a subscription-only fleet and
   `heldUntil` the rejected window's deadline), carried through src/ui/status-payload.ts.
2. **Rendering, following the design table.**
   - **subscription only:** the window replaces the daily spend, e.g.
     "Claude 5h · 64% · resets 14:30" (the status word when no `utilization`), amber at
     `allowed_warning`, red with "claude seams held until 14:30" at `rejected`, and an "overage"
     marker while `isUsingOverage`.
   - **mixed:** both, the daily-spend badge with the window appended; the daily spend already
     covers priced seams only (6a folds subscription cost into notional spend).
   - **none:** unchanged.
   The single preformatted budget fragment is src/ui/badges.ts's `budgetBadge`, rendered by the
   TUI header (src/ui/status-render.ts) and carried preformatted in the payload; the GUI
   sidebar's spend card (src/ui/gui/gui-client-operator.ts, reached from gui-client-fleet.ts's
   renderSidebar) lists every window.
3. **Role view.** src/roles/role-view.ts collects the billing and its primary window;
   src/roles/role-render.ts shows "- Billing: subscription (5h window)" or "- Billing: API" for
   a claude seam.
4. **Docs.** README: the window display.

**Files touched.** src/status/status-data.ts, src/ui/status-payload.ts, src/ui/badges.ts,
src/ui/status-render.ts, src/ui/gui/gui-client-operator.ts, src/roles/role-view.ts,
src/roles/role-render.ts, src/agent/claude/claude-account.ts, README.md.

**Tests.** Cases in test/badges.test.ts, test/gui-client.test.ts, test/status-data.test.ts,
and test/role-view.test.ts.

**Acceptance criteria.**
- An all-subscription fleet's TUI and GUI show the window line and no daily-spend line.
- A mixed fleet shows both lines, the daily spend covering priced seams only.
- A pi-only fleet's rendering is byte-identical to before.
- `tumwater role <id>` names the billing for a claude seam.
- `npm run test` green.

### Agent backends, part 6b/7: subscription free-ness and the cap exemption (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 6/7; requires part 6a/7 landed; done 2026-10-10 by feature)

Design: plans/agent-backends.md ("Free-ness", "Every seam, checked").

Goal: a subscription claude seam is free money, so the daily cap never moves it to a fallback
and an all-subscription fleet resolves as free. Depends on 6a's account state.

**Approach.**
1. **Free predicate.** src/pi/pi-models.ts gained `seamFree(providers, seam, account)`, the one
   agent-aware rule: a claude seam is free while the account billing is `subscription` and no
   window is using overage, a pi seam is free when models.json prices it at zero, and everything
   else is not free. Overage is real money (plans/agent-backends.md §7), so `accountUsesOverage`
   mirrors the per-run `runCostIsReal` split: an overage subscription claude seam is priced like
   API spend. `piPairFree` (the `provider/model` form), `fallbackModelPair`, `fallbackModelFree`,
   and `fleetModelsFree` all take an optional `ClaudeAccount | null` and judge through it; an
   absent account file or API billing keeps today's refusal.
2. **Callers follow.** src/gates/budget-gates.ts reads the account once per poll and passes it to
   `pairFreeAt` and to `applyFallbackModel`; src/status/status-data.ts passes it to the
   `fleetModelsFree` / `fallbackModelFree` / seam-free reads; src/roles/role-view.ts and
   src/doctor/doctor-model-checks.ts read it for their `fallbackModelPair` verdict. `applyFallbackModel`
   (src/config/config-views.ts) gained an optional free predicate: a free tier keeps its own
   primary in the model map, a free role keeps its own override, and a free reviewer keeps its
   own model, while every priced seam still lands on its tier's fallback pair. So the gate leaves
   a subscription seam put at the cap, accepts a subscription claude pair as a budget `fallback`
   for a priced pi primary, and `fleetModelsFree` turns true for an all-subscription fleet (which
   6d renders as the window badge).
3. **Docs.** README states a subscription claude model with no overage is free and so is never
   moved to a budget fallback.

**Files touched.** src/pi/pi-models.ts, src/gates/budget-gates.ts, src/config/config-views.ts,
src/status/status-data.ts, src/roles/role-view.ts, src/doctor/doctor-model-checks.ts, README.md.

**Tests.** test/pi-models.test.ts (subscription free; API, overage, and absent refused),
test/budget-gates.test.ts (subscription fallback engages; a subscription seam stays put while a
priced pi seam moves; an overage subscription seam moves), test/config-views.test.ts
(applyFallbackModel's free predicate), test/role-view.test.ts and
test/doctor-model-checks.test.ts (a subscription claude fallback reads free).

**Acceptance criteria.**
- With the cap reached and account billing `subscription`, a subscription claude seam stays
  put while a priced pi seam moves to its fallback.
- A subscription claude pair is accepted as a budget `fallback` for a priced pi primary.
- `fleetModelsFree` is true when every seam is subscription claude and false when one seam is
  API-billed claude or the account is using overage.
- The role view and doctor judge a subscription claude fallback free, like the budget gate.
- With no account file or API billing, free-ness is exactly today's behavior.
- `npm run test` green.

### Agent backends, part 6c/7: the usage-window hold and its events (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 6/7; requires part 6a/7 landed; done 2026-10-10 by feature)

Design: plans/agent-backends.md ("Throttle", "Watchdogs and progress").

Goal: a rejected subscription window holds claude seams until it resets, so the fleet does not
burn a failed run per loop per poll. Depends on 6a's account state.

**Approach.**
1. **The hold.** A window reading with `status: "rejected"` and no overage places a
   provider-`claude` fleet hold until `resetsAt` (src/fleet/fleet-hold.ts and
   src/fleet/fleet-polls.ts). It joins the existing per-provider holds map, so
   `heldProviders()` gates scheduling exactly as a failure storm does. It covers subscription
   claude seams only: pi seams, and API-key claude seams, keep ticking. A rejected run is a
   transient — nothing is reset.
2. **Integration.** fleet-polls derives the window observation from the account state (via 6a's
   reader) alongside the runner failure observations, with the same self-lifting guarantee
   (a held fleet re-opens when `resetsAt` passes).
3. **Events (once per window, not per run).** `claude_window_warning` on the first
   `allowed_warning`, `claude_window_limited` `{windowType, resetsAt}` when the hold is placed,
   and `claude_window_reset` when it lifts (src/events/events.ts, src/events/event-format.ts).
   The field is `windowType` because the event's own `type` names the event.

**Files touched.** src/fleet/fleet-hold.ts, src/fleet/fleet-polls.ts,
src/agent/claude/claude-account.ts (reader use), src/config/config-views.ts,
src/loop/loop.ts, src/orchestrator/orchestrator.ts, src/gates/gate-polls.ts,
src/events/events.ts, src/events/event-format.ts, README.md.

**Landed note.** The hold is keyed by the seam hold key (config-views.ts seamHoldKey): a non-pi
backend keys by its agent id (configForRole clears a claude seam's pi provider), so claude seams
share the `claude` hold and pi's default seams (undefined) stay clear. LoopRunner.runProvider and
the reviewer's held-provider reads now use it, so claude failure storms also key `claude`
rather than undefined. The once-per-window warning memory lives in FleetGateStates beside the
holds map.

**Tests.** Cases in test/fleet-hold.test.ts, test/fleet-polls.test.ts, test/event-format-fleet.test.ts,
test/config-views.test.ts.

**Acceptance criteria.**
- A `rejected` five-hour reading holds subscription claude seams until `resetsAt` while pi seams
  and API claude seams tick.
- Many polls across one rejected window log `claude_window_limited` once and
  `claude_window_reset` once.
- A first `allowed_warning` logs `claude_window_warning` once.
- A window with overage, or after `resetsAt`, places no hold.
- `npm run test` green.

### Agent backends, part 6a/7: the claude account state and notional spend (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 6/7; requires parts 4a/7, 4b/7 and 4e/7 landed; done 2026-10-10 by feature)

Design: plans/agent-backends.md ("Billing: subscription or API", "The subscription usage
window", "Testing").

Goal: detect whether a claude run is paid by a claude.ai subscription or an API key, persist
that answer, and keep subscription cost out of the daily dollar budget. This is the foundation
the sibling 6b/7–6e/7 parts read; it changes no scheduling, badge, or display behavior on its own.

**Approach.**
1. **Account state.** src/agent/claude/claude-account.ts reads and writes
   `.tumwater/state/claude-account.json`:
   `{billing, subscriptionType, observedAt, windows: {<rateLimitType>: {status, resetsAt,
   utilization?, overageStatus, isUsingOverage, observedAt}}}`. Exports the `ClaudeAccount`,
   `ClaudeBilling` types plus an internal `ClaudeWindow` shape and a reader that treats a
   window past its `resetsAt` as reset (and an `observedAt`-less file as absent). Only the
   orchestrator process writes it; the path lives in src/paths.ts.
2. **Seeding.** seedClaudeAccount (claude-account.ts) seeds before the first run from the
   presence of `ANTHROPIC_API_KEY`/a third-party provider env and, otherwise, `claude auth
   status` (`authMethod: "claude.ai"`, `subscriptionType`); src/gates/startup-gate.ts calls it
   when a seam routes to claude and an account file is absent. Doctor's existing `claude auth
   status` check already surfaces the same billing.
3. **Per-run observation.** src/tick/tick-finalize.ts (which has the repo root; run-agent.ts does
   not) folds each tick's `billing` and newest `rateWindows` — carried on `PiRunResult` in
   src/pi/pi-run-result.ts and collected by src/tick/tick-usage.ts — into the account file,
   stamping `observedAt`.
4. **Spend.** src/tick/tick-usage.ts folds a subscription run's `costUsd` into a new
   `notionalCostUsd` and never calls `recordDailyCost`; an API run, or a run that saw
   `isUsingOverage` at any point, folds its cost into `costUsd` as today (its cost is real
   money). src/pi/pi-run-result.ts's `runCostIsReal` is the one predicate both the tick fold
   and the landing accumulator split on. A landing/review run (reviewer + conflict resolution)
   is split the same way in src/landing/landing-slot.ts: real cost rides the landed event's
   `costUsd`, notional rides a new `notionalCostUsd` field. `tick_end` gains `notionalCostUsd`
   and `billing` (src/events/events.ts's usageFragment and src/events/event-read.ts's
   eventUsage, following the omit-when-zero convention the other usage fields use).
5. **Report.** src/report/report-data.ts sums notional spend apart from the totals — fleet-wide
   and, for a `--role` scope, the role's own tick notional (its landing slot's is fleet-wide
   like its cost) — and src/report/report-render.ts prints it on its own line ("claude
   subscription, API-equivalent: $X notional"), never in the total.
6. **Docs.** README: billing detection and overage counting as real spend.

**Files touched.** src/agent/claude/claude-account.ts (new), src/paths.ts,
src/tick/tick-finalize.ts, src/gates/startup-gate.ts, src/tick/tick-usage.ts,
src/pi/pi-run-result.ts, src/landing/landing-slot.ts, src/events/events.ts,
src/events/event-read.ts, src/report/report-data.ts, src/report/report-render.ts, README.md.

**Tests.** test/claude-account.test.ts (new); cases in test/tick-usage.test.ts,
test/landing-slot.test.ts, test/report-data.test.ts.

**Acceptance criteria.**
- With `maxDailyCostUsd: 15` and subscription billing, ten fake-claude ticks costing $3 each
  leave the daily spend at $0, and `tumwater report` shows "$30.00 notional".
- The same ticks with `isUsingOverage: true` count $30 against the cap.
- With `apiKeySource: "ANTHROPIC_API_KEY"`, costs count against the cap exactly as a priced pi
  model's do, and the report's notional line stays at $0.
- A window whose `resetsAt` has passed reads as reset; an absent account file reads as no
  subscription.
- `npm run test` green.

### A numbered read half for `tumwater plan`/`bug`: `--list` (planned 2026-10-10 by plan; independent of the Agent backends series; sibling of the landed `tumwater plan --edit/--cancel` and `tumwater bug --edit/--cancel`; done 2026-10-10 by feature)

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

Tests: test/backlog-write-list.test.ts — a fixture with two planned entries (one eligible, one
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

### Agent backends, part 5/7: `role_notes` over MCP and the prompt dialect (planned 2026-10-09 by operator; requires parts 4a/7 and 4b/7 landed; done 2026-10-10 by feature)

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
- src/agent/claude/claude-args.ts, src/agent/claude/claude-backend.ts
- src/prompt/prompt.ts, src/prompt/prompt-followup.ts, src/prompt/dialect.ts (new)
- src/tick/tick-prompt.ts, src/tick/tick-resume.ts

Tests: test/role-notes-mcp.test.ts (spawn the server, call the tool, check the file and the
cap), test/prompt-dialect.test.ts (pi byte-identity and the claude wording), and claude-run
cases for the MCP config on fresh and resumed runs.

**Acceptance criteria.**
- **Unchanged pi.** pi tick prompts are byte-identical to before.
- **claude prompts.** A claude tick prompt names `mcp__tumwater__role_notes`. A claude authoring
  run on fake-claude receives `--mcp-config` naming the server. Director, review and landing runs
  do not.
- **Server.** The server rejects a note over 4 KB with a tool error, and leaves the old note
  intact.
- `npm run test` green.

**Landed.** src/agent/role-notes-write.ts holds the shared 4 KB cap, schema, validation, and
atomic write; the pi extension and src/agent/mcp/role-notes-server.ts (a dependency-free stdio
MCP server) both call it, and the claude adapter passes that server as inline `--mcp-config`
plus TUMWATER_NOTES_PATH whenever the run carries a notebook — on resumes too, since claude keeps
no flags across `--resume`. src/prompt/dialect.ts holds pi's and claude's only backend-specific
prompt text; `contextBudgetRule`/`roleNotesInstruction` and `buildResumePrompt` take a dialect,
and pi's text is byte-identical (test/prompt-dialect.test.ts). `buildHandoffPrompt`,
`buildRevisionNote`, and `buildConflictHandbackNote` name no tool or notes file, so they needed no
dialect argument; a handoff's assembled tick prompt already carries the right dialect. The
AGENTS.md append was already in the part 3b/7 invocation builder, so this part changed no code
for it.

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

- A History view in `tumwater tui` matching `tumwater history` (planned 2026-10-09, done 2026-10-09; commit bcf7af7d)
- Inspect a loop's notebook and next tick prompt in the TUI (planned 2026-10-09, done 2026-10-09; commit e691525a)
- Mark why a backlog entry is held in `tumwater backlog` (planned 2026-10-09, done 2026-10-09; commit a9d2699a)
- Inspect a loop's notebook and next prompt in the dashboard drawer (planned 2026-10-09, done 2026-10-09; commit 9a9db71f)
- Notify the operator when a loop posts a question (planned 2026-10-09, done 2026-10-09; commit ccec1af5)
- Agent backends, part 3c3/7: backend-aware resumability across the loop (planned 2026-10-09, done 2026-10-09; commit e01e5126)
- Agent backends, part 3d/7: `resumeMissing` resumes as a `handoff` (planned 2026-10-09, done 2026-10-09; commit 8a9c2d74)
- Agent backends, part 3c2/7: the claude native log and translator warnings (planned 2026-10-09, done 2026-10-09; commit 11522335)
- Agent backends, part 3c1/7: the claude backend adapter and PATH fake (planned 2026-10-09, done 2026-10-09; commit 06e86d12)
- A review retry picks up the timed-out reviewer's session, part 3/3: resumed-review event and failure digest (planned 2026-10-09, done 2026-10-09; commit 01f08247)

- A review retry picks up the timed-out reviewer's session, part 2/3: record and resume a progressing-timeout review session (planned 2026-10-09, done 2026-10-09; commit 6f3f0f27)
- Retract a config value: `tumwater config unset <key>` (planned 2026-10-09, done 2026-10-09; commit 5be2d7ed)
- Edit an operator-filed backlog entry: `tumwater plan --edit <n>` and `tumwater bug --edit <n>` (planned 2026-10-09, done 2026-10-09; commit a2f09d37)
- A review retry picks up the timed-out reviewer's session, part 1/3: per-review session directories (planned 2026-10-09, done 2026-10-09; commit 9876cb8b)
- Agent backends, part 3b/7: the claude invocation and isolation environment (planned 2026-10-09, done 2026-10-09; commit 38c752f4)
- Agent backends, part 3a/7: the claude stream translator and canonical vocabulary (planned 2026-10-09, done 2026-10-09; commit 0694aadf)
- Cover failure-caused loop pauses and model fallbacks in the failure digest's Fleet state changes (planned 2026-10-09, done 2026-10-09; commit 91cddcfc)
- A trailing window for the failure digest: `tumwater report --failures --since <duration>` (planned 2026-10-09, done 2026-10-09; commit 3ea92811)
- Cancel an operator-filed backlog entry: `tumwater plan --cancel <n>` and `tumwater bug --cancel <n>` (planned 2026-10-09, done 2026-10-09; commit 209f1623)
- Agent backends, part 2/7: a session ledger and the `handoff` resume (planned 2026-10-09, done 2026-10-09; commit 9f15ccee)

- Agent backends, part 1/7: the `AgentBackend` seam, with pi as its only adapter (planned 2026-10-09, done 2026-10-09; commit f7931c9e)
- Split the LoopRunner tick pipeline out of src/loop/loop.ts (planned 2026-10-08, done 2026-10-09; commit 49659ce8)
- Parallel work instances, part 7/7: keep permit headroom for work loops that have work to take (planned 2026-10-07, done 2026-10-09; commit 09a8deac)
- Stop showing leased worktree slots in the TUI and GUI (planned 2026-10-09, done 2026-10-09; commit f5d3b41e)
- Work ratio, part 1b/4: the scheduler holds maintenance loops past their allowance (planned 2026-10-08, done 2026-10-09; commit 94a76b2f)
- Work ratio, part 1a/4: the maintenance allowance — window counts, the verdict and the `maintenancePerWorkLanding` setting (planned 2026-10-08, done 2026-10-08; commit d0918d6d)
- Work ratio, part 2/4: a clean tick sweeps one kind of drift across the tree instead of one site (planned 2026-10-08, done 2026-10-08; commit cd533c0a)
- Parallel work instances, part 6/7: show instances and claims on status, TUI, GUI, logs and doctor (planned 2026-10-07, done 2026-10-08; commit 11025166)
- Worktree pool, part 5/5: slot waits, slot display, doctor check and docs (planned 2026-10-06, done 2026-10-08; commit 4b3c4234)
- Worktree pool, part 4c/5: retire legacy role worktrees at orchestrator start (planned 2026-10-06, done 2026-10-08; commit a0da7193)

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
