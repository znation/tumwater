# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Check-permit priority, part 2/2: Measure after the reviewer plan lands, then decide whether the cap rises (planned 2026-10-23 by user; design in plans/check-permit-priority.md "What lands" item 2; requires reviewer-as-role parts 1/4 and 3/4 landed (post-merge review removes the demoted roles' pre-merge gate checks; the convergence rule removes the 3–6-round tail that multiplies one item into a dozen checks); touches tumwater.json docs/config.md)

**Refused 2026-10-23 by feature: executing the decision now needs one week of post-reviewer-plan `check_wait` data, but reviewer-as-role parts 1/4 and 3/4 are still under `## Planned` (not landed), so no evidence exists and raising the cap 3→4 now would be the theory-knob this plan's "not a knob raised on theory" decision rejects**

**Goal.** The 24-min waits were burst-driven and demand-driven; both causes land as fixes elsewhere. This part is the decision procedure that says whether any capacity change is still needed — not a knob raised on theory.

**Approach.**
- After reviewer-as-role parts 1/4 and 3/4 have run for one week, read the week's `check_wait` events and the day report's `checkWaitMedianMs`: if no `check_wait` carries waitedMs ≥ CHECK_WAIT_EVENT_MS (30 s), the cap stays 3 and this plan's outcome is "no change needed" — recorded in PLANS-DONE when the part closes.
- Otherwise raise `maxConcurrentChecks` 3 → 4 in tumwater.json and the default stays 2 (src/config/config.ts) — a dogfood decision, not a default change — and watch the load-storm signal: `merge_blocked` events naming "host load average" (as 10-21's feature-7 and bugfix-4 did at load 20 on 18 cores). The doctor's `checkCheckContention` already warns and names the knob; the feedback loop exists.

**Acceptance criteria.**
- The decision (either branch) is recorded with its evidence in PLANS-DONE.md when closed; a raised cap is accompanied by one week of load-watch in the dogfood instance.
- `npm run test:gate` passes (config change only; no code).

### Interlock relief, part 1/2: The merge-queue interlock holds only what the feedback contract needs — a queued author whose change is approved may run (planned 2026-10-23 by user; design in plans/interlock-relief.md "The decision" and "What lands"; evidence: queue waits before landing ran median 5 min, max 3 h 17 m over 58 h, and the interlock parks the author for the whole window; one switch: `afterMerge` opts a role into both post-merge review and this relief (Reviewer as a regular role, part 1/4, landed); touches src/merge/merge-queue.ts src/orchestrator/orchestrator-scheduling.ts src/runner/leftover.ts and their tests)

**Goal.** plans/merge-queue.md invariant 3 ("a loop with a queued or landing change is not eligible to tick") exists to preserve the `state.lastReview` feedback contract. For post-merge-review roles that contract no longer needs the pre-merge pipeline: scope the interlock per role and per stage, so an author whose change is approved-and-waiting or in the fast-forward is not parked, while the stages that actually race the author's branch stay exclusive.

**Approach.**
- src/merge/merge-queue.ts: `queuedMergeRoles` (or its scheduler-side caller) gains the entry's stage. The scheduling skip (src/orchestrator/orchestrator-scheduling.ts, the `queuedRoles.has(runner.role)` skip) applies to a role whose entry is pre-approval (under review or checks) or in a conflict/`main_red` hold (`resolve-wait`, `resolving`, a held pin) — not to one approved-and-waiting or in the merge's fast-forward.
- The per-role tiering follows `review.afterMerge` exactly: a role on that list gets the scoped interlock; a pre-merge-review role keeps today's full interlock (its rejection must reach the runner before it authors again — that is the contract's original case).
- The queue's own per-runner cap is unchanged: a role with a queued change still cannot queue a second (invariant 3's "no change accumulates more than one commit ahead of main"); an author whose new run finishes while its previous change is queued holds the new commit on the branch until the entry drains. The author's next run starts from `reset --hard main` as always, so a queued-approved change does not block its author's tree.
- src/runner/leftover.ts: consult `ctx.mergeReviewError` and `ctx.mainRedRetry` before the pin is read or written — the pin-present path is unchanged, but the pin-absent path must not fall into the branch-tip adoption below. A held `main_red` pin is not a queue entry, so the scoped interlock admits the role and the run can reach recovery with a held record and the previous run's commit on the branch; adopting the tip then would create or repoint `refs/tumwater/merge/<role>` at the held commit and lose the kept sha (the review's repro). When the pin is missing and a held record stands, do not adopt: return the record's own held outcome (`held`, or `main_red_wait` with the held head) with the branch tip's sha, so the commit survives for the next run and the kept record is not silently re-labelled.
- plans/merge-queue.md invariant 3's text is updated to the scoped form with a pointer to plans/interlock-relief.md; docs/glossary.md's `waiting to merge` row keeps its meaning (it names the queue, not the run gate).

**Acceptance criteria.**
- A post-merge-review role with an approved queued entry starts its next run in the same poll it would have started in with an empty queue; the same role with an entry in `resolve-wait` or under review does not start (test over both stages).
- A pre-merge-review role (feature) with any queued entry still does not start — today's behavior, test unchanged.
- A recovery run with a branch commit ahead of main, no pin, and `mainRedRetry` (or `mergeReviewError`) set creates or repoints no `refs/tumwater/merge/<role>`, leaves the branch commit in place, and ends on the held/`main_red` path (test in test/leftover.test.ts) — the review's repro.
- `npm run test:gate` passes.

### Interlock relief, part 2/2: Docs state which roles wait on their merge and which do not (planned 2026-10-23 by user; design in plans/interlock-relief.md "What lands" item 2; requires part 1/2 landed; touches docs/how-it-works.md docs/glossary.md plans/merge-queue.md)

**Goal.** An operator reading the merge-pipeline section can predict which roles author through a queued change and which park, and why the split follows `review.afterMerge`.

**Approach.**
- docs/how-it-works.md, the merge-pipeline/scheduling sections: the interlock paragraph states the two tiers and the stage exclusions (pre-approval, conflict, main-red) as behavior, one paragraph, no new terms.
- docs/glossary.md: the `waiting to merge` status row gains the half-sentence "for pre-merge-review roles, this also holds the role's next run" — the scoped behavior is the row's whole difference.
- plans/merge-queue.md's invariant text carries the final wording (part 1/2 edits it; this part reconciles any drift from review).

**Acceptance criteria.**
- The three docs agree on the tiers and the excluded stages; grep finds no remaining unscoped "a role with a queued change never runs" claim outside plans/ as historical record.
- `npm run test:gate` passes (docs only).

### Write guard on Codex, part 7/9: Codex's prompt dialect sends file edits through `apply_patch` (planned 2026-10-23 by user; requires part 6/9 landed; design in plans/codex-write-guard.md "Coverage (part 7)" and finding 6; touches src/prompt/dialect.ts test/prompt-dialect.test.ts)

**Goal.** The guard sees only `apply_patch`. plans/codex-backend.md's probes saw codex models edit through the shell (`printf >>`) unless the prompt asked for `apply_patch`, so ask for it.

**Approach.**
- src/prompt/dialect.ts: `CODEX_DIALECT.backendRules` gains one rule: "Edit and create files with the `apply_patch` tool, not shell redirection (`>`, `>>`, `tee`) or `sed -i`."
- Update the `CODEX_DIALECT` doc comment to say why: the write guard checks only `apply_patch` (plans/codex-write-guard.md).

**Tests.** test/prompt-dialect.test.ts:
- a codex run prompt contains the rule exactly once;
- the pi, claude and OpenCode run prompts do not contain it;
- the codex prompt's other backend rule (the `write_stdin` polling rule) is still present.

**Acceptance criteria.**
- Only codex prompts change, by exactly that rule.
- `npm run test:gate` passes.

### Write guard on Codex, part 8/9: Doctor's codex group reports whether codex runs carry the write guard (planned 2026-10-23 by user; requires part 6/9 and Codex backend 9a/9 landed; design in plans/codex-write-guard.md "Visibility (parts 8–9)"; touches src/doctor/doctor-model-checks.ts test/doctor-model-checks.test.ts)

**Goal.** An operator can see from `tumwater doctor` whether codex edits are guarded, and why not when they are not.

**Approach.**
- src/doctor/doctor-model-checks.ts: in the codex check rows Codex backend part 9a/9 adds (each shown when any job routes to codex), add a `write guard` row.
- The row runs `codexHookTrust` for the run env's home and the current build's definition, bounded at 10 s like the group's other Codex calls.
  - pass: `trusted (sha256:<first 12 hex>)`;
  - warn: `off: <reason> — codex runs edit without the worktree check`.
- Doctor stays read-only apart from the cache file, which `codexHookTrust` already writes.

**Tests.** test/doctor-model-checks.test.ts, on the fake:
- a fake that lists the hook gives the pass row with the hash prefix;
- a fake whose list is empty gives the warn row naming the reason;
- a pi-only team shows no codex group, so no row.

**Acceptance criteria.**
- Both rows render as above.
- `npm run test:gate` passes.

### Write guard on Codex, part 9/9: The live `smoke:codex` step for the guard, and the docs (planned 2026-10-23 by user; requires part 6/9 and Codex backend 9c/9 and Codex backend 9d/9 landed; design in plans/codex-write-guard.md "Visibility (parts 8–9)" and "Risks"; touches scripts/smoke-codex.mjs docs/how-it-works.md docs/backends.md plans/codex-backend.md)

**Goal.** After a Codex upgrade, one live command proves the guard still blocks. Session-flag trust could stop working while the `hooks/list` lookup still succeeds ("Risks"). The docs should say which backends are guarded and how.

**Approach.**
- scripts/smoke-codex.mjs (added by Codex backend part 9d/9) gains a `write guard` step.
  - Build a throwaway team layout: a git repo `<T>/repo`, its worktree `<T>/repo/.tumwater/worktrees/_slot-1`, and the same `notes.md` text in both. Keep the session dir under `<T>/repo/.tumwater/sessions`, never outside a `.tumwater` root.
  - Run the production invocation through `runAgent`, asking the model to use `apply_patch` to change `notes.md` at the primary's absolute path, and to follow any refusal.
  - Assert three things: the primary's `notes.md` is unchanged, the worktree's `notes.md` changed, and the run's rollout holds "blocked by PreToolUse hook".
  - The step is listed by the script's `--help`/dry-run.
- docs/how-it-works.md, "A run" step 2: the guarded tools name codex's `apply_patch`, through a trusted hook. Shell writes stay unchecked on every backend.
- docs/backends.md, Codex section:
  - the guard is a PreToolUse hook passed with `-c`, trusted through the same session-flag layer with the hash Codex reports;
  - `codex-hook-trust.json` caches the hash;
  - `--dangerously-bypass-hook-trust` is never used.
- plans/codex-backend.md: under "never passes `--dangerously-bypass-hook-trust`", add one sentence: tumwater trusts only its own write-guard hook, through the session-flag layer (plans/codex-write-guard.md).

**Tests.** None beyond the script's dry-run listing. The live step runs by hand: `npm run smoke:codex`.

**Acceptance criteria.**
- `npm run smoke:codex -- --help` (or the script's dry-run flag) lists the `write guard` step.
- The docs name codex among the guarded backends and its `apply_patch`-only coverage.
- `npm run test:gate` passes.

### `tumwater start --once --json` prints the round's per-role outcomes as one JSON object, so a cron/CI caller does not parse the prose summary (planned 2026-10-23 by the plan role; independent of every eligible plan — the interlock and pollRunnerReasons-split series touch src/orchestrator and src/merge, the Codex write-guard parts touch src/agent, src/prompt and docs/backends, and the merge-slot median touches src/report and src/ui/gui; the only shared file is docs/cli.md, where this edits the `Start the team` once block and that plan edits the `tumwater report` row, so whichever lands second rebases there; touches src/cli/cli-start.ts src/cli/cli-flag-specs.ts src/cli/help.ts docs/cli.md test/cli-start.test.ts test/cli-start-once.test.ts)

**Goal.** `tumwater start --once` is the README's cron/CI command: it does one round, prints a one-line prose summary (`onceSummary`) plus a `once: failed — …` line when the round failed, and exits 3 on such a failure. A CI step that wants per-role outcomes — which role merged, which errored, which was skipped and why — has to scrape that prose. Add `--json`, valid only with `--once`, that prints the same round facts as one JSON document on stdout with the banner and the event stream suppressed, so the caller parses the round directly.

**Approach.**
- src/cli/cli-start.ts: split `onceSummary` into a structured `onceReport(root, roles, runsBefore, settled, runsDone)` and a `renderOnceSummary(report)` that produces today's exact line; keep `onceSummary` as their composition so its exported signature and every existing test stay unchanged. `onceReport` walks the existing `onceRoundRoles`/`onceFailures` helpers and returns `{ runs, outcomes, skipped, failures }`:
  - `runs`: the round's total run count (the `ran > 0` sum).
  - `outcomes`: `{ [result: string]: number }`, one key per result a ran role ended on (`state.lastResult ?? "no_change"`), inserted in the `compareCodeUnits`-sorted order `onceSummary` uses.
  - `skipped`: `[{ role, reason }]` in role order, one entry per role with `ran === 0`, `reason` resolved exactly as `onceSummary` resolves it (the `settled` map, then the pause marker, then `stateSkipReason`).
  - `failures`: `onceFailures(...)` verbatim.
- In `cmdStart`, read `const json = args.includes("--json");` beside `once`, and beside the `--role` guard add `if (json && !once) fail("--json is only valid with --once");`. When `json` is true, skip the three banner `say(...)` lines and the `subscribeEvents((e) => say(formatEvent(e)))` subscription, and after the round print `sayJson(onceReport(...))` instead of the `onceSummary` line; the `onceFailures` line and the `ONCE_FAILED_EXIT_CODE` exit are unchanged. The orchestrator and merge pipeline record events through `logEvent` (file plus subscription), not stdout, and the supervisor prints nothing on stdout for a once round, so stdout then holds exactly the one JSON document.
- src/cli/cli-flag-specs.ts: add `JSON_FLAG` to `START_FLAG_SPECS` and widen the spec's doc comment to name `--once --json`.
- src/cli/help.ts: add `[--json]` after `[--once]` in the `tumwater start` synopsis, and under the `--once` stanza add one wrapped line: ``--once --json prints the round's totals, per-result counts, skipped roles and failures as one JSON object on stdout (no banner or event stream); only valid with --once;``.
- docs/cli.md: in the `Start the team` block, under the `tumwater start --once` comment line, add `# add --json to print the round's totals, per-result counts, skipped roles and failures as one JSON object (only with --once)`.

**Tests.**
- test/cli-start.test.ts: a new test for `onceReport` over the same seeded state the `onceSummary` tests use — one advanced run and one skipped role — asserting `runs`, the sorted `outcomes`, the `skipped` role/reason pairs, and `failures`; and that `onceSummary(...)` still equals `renderOnceSummary(onceReport(...))`.
- test/cli-start-once.test.ts: a new test `run --once --json prints one JSON object and no banner or event stream` — `withIdlePi`, `cli(repo, "run", "--once", "--json")`, `JSON.parse(r.stdout)` gives `runs: 1`, `outcomes: { no_change: 1 }`, empty `skipped` and `failures`, and `r.stdout` matches neither `/tumwater once on branch/` nor `/roles:/`; a second test `run --json without --once is refused` — `cli(repo, "run", "--json")` exits 1 with `/--json is only valid with --once/` and boots nothing.

**Acceptance criteria.**
- `tumwater start --once --json` writes exactly one parseable JSON object to stdout (no banner, no event lines) and exits 0, or 3 when the round failed, carrying `runs`, `outcomes`, `skipped` and `failures`; `--once --role clean --json` carries only clean's work.
- `tumwater start --json` without `--once` exits 1 with `--json is only valid with --once`; the daemon and `--for` output are unchanged.
- `tumwater start --once` (no `--json`) prints the same banner, event stream and summary line as before.
- `npm run test:gate` passes.

### Backlog hold convergence, part 1/3: The held count and the held-for-operator hold (planned 2026-10-23 by the plan role, split from the user's "Backlog hold convergence" plan; the read half of the convergence backstop — parts 2/3 and 3/3 surface and write the count; touches src/roles/role-guidance.ts src/backlog/backlog-eligibility.ts src/prompt/notes-backlog.ts test/backlog-eligibility.test.ts)

**Goal.** A Needs-review/Needs-replan note gains a held count, and an entry whose count reaches three becomes `held-for-operator`: `entryHold` classifies it as its own hold, the plan role no longer takes it, and every surface can see why. This part is the data layer only.

**Approach.**
- src/roles/role-guidance.ts: export the two literals both halves share — `HELD_TAG_PREFIX = "(held "` (the tag text before the number, so the parser and the note templates cannot drift) and `PRIOR_HELD_PREFIX = "**Previously held "` — beside the existing note prefixes. Document that the live count is `(held N)` on the note and the surviving marker after a lift is `**Previously held N**`.
- src/backlog/backlog-eligibility.ts: export `OPERATOR_HOLD_THRESHOLD = 3`. Add `heldCount(body: string): number` — the integer in the first Needs-review or Needs-replan note line's `(held N)` tag, else the integer in a `**Previously held N**` line, else 0; a missing or non-numeric tag is 0 and never throws.
- In `entryHoldAgainst`, before returning `"needs-review"`/`"needs-replan"` for a present note, return `"held-for-operator"` when `heldCount(body) >= OPERATOR_HOLD_THRESHOLD`. Add `"held-for-operator"` to the `EntryHold` union; `holdMark` renders ` [blocked: held for operator]`.
- src/prompt/notes-backlog.ts: `holdWording` gains a `held-for-operator` branch (e.g. `held for the operator (tumwater plan --release)`) and `seriesInfos` counts it with `needs-review`, so the notes block does not fall through to the `blockedBy` wording for a string hold.
- No change to the plan-role wake gate (`planBacklogFull`, src/scheduling/claims.ts): it already tests only `"needs-review"`/`"needs-replan"`, so a held-for-operator entry neither keeps the plan role running nor counts as an eligible plan. Verify with a test rather than editing it.

**Tests.**
- test/backlog-eligibility.test.ts: `heldCount` reads `(held 3)` from a Needs-review line, `(held 2)` from a Needs-replan line, `2` from `**Previously held 2**` when no note is present, and `0` when neither; a `(held x)` tag is 0.
- An entry with a `**Needs review … (held 3)**` line yields `entryHold` `"held-for-operator"` and `holdMark` `[blocked: held for operator]`; the same note with `(held 2)` yields `"needs-review"` (today's behavior); a bare `**Needs review …**` still yields `"needs-review"`.
- `planBacklogFull` is true (the plan role stops) for a backlog whose only marked entry is held-for-operator.

**Acceptance criteria.**
- `entryHold` returns `"held-for-operator"` exactly for a present Needs-review/Needs-replan note whose count is at least 3, and `"needs-review"`/`"needs-replan"` otherwise; an untagged note keeps today's classification.
- `heldCount` is pure over the body and never throws; `holdMark` words the new hold as ` [blocked: held for operator]`; the prompt notes block names it without falling through.
- `npm run test:gate` passes.

### Backlog hold convergence, part 2/3: The operator sees a held-for-operator entry and `--release` clears it (planned 2026-10-23 by the plan role, split from the user's "Backlog hold convergence" plan; requires part 1/3 landed; touches src/backlog/backlog-eligibility.ts src/backlog/backlog-release.ts src/doctor/doctor-backlog-plans.ts src/ui/team-alerts.ts src/ui/status-model.ts and their tests)

**Goal.** A held-for-operator entry is visible to the operator with `tumwater plan --release` as the way out, and release actually lifts it — today `--release` lifts only Refused and Waiting notes and deliberately leaves Needs-review alone.

**Approach.**
- src/backlog/backlog-eligibility.ts: add `operatorHeldEntries(root): RefusedEntry[]` beside `refusedEntries`, returning the planned plans whose hold is `"held-for-operator"`, each with `file: "plans"`, its 0-based index and title (reuse the `RefusedEntry` shape and the `backlogHolds` + `plannedPlanEntries` pairing).
- src/backlog/backlog-eligibility.ts: add `withoutHeldForOperatorNotes(lines)` (through `withoutNoteLines`) dropping a `**Needs review … (held N)**`/`**Needs replan … (held N)**` line and its `**Previously held N**` line together. It drops nothing when the note's count is below the threshold, so `--release` still cannot lift a live first/second Needs-review hold.
- src/backlog/backlog-release.ts: `liftRefusal` gains a third branch after Refused and Waiting — when the entry's `entryHold` is `"held-for-operator"`, splice out the held note and prior-held line via `withoutHeldForOperatorNotes`; otherwise `not_refused` as today.
- src/doctor/doctor-backlog-plans.ts: `checkStalledPlans` keeps its needs-review/replan branch and adds a held-for-operator branch whose warn names the entry, its `(held N)`, and `tumwater plan --release` as the recovery (the plan role does not resolve this one).
- src/ui/team-alerts.ts: a new amber alert (key `"operator-held"`) listing `operatorHeldEntries` through `entryListDetail`, with the refused alert's "Open backlog" action and text naming `tumwater plan --release`; add the input to `buildAlerts`'s params (default `[]`) and pass `operatorHeldEntries(root)` from src/ui/status-model.ts beside `refusedEntries(root)`.

**Tests.**
- test/backlog-eligibility.test.ts: `operatorHeldEntries` returns a `(held 3)` plan and not a `(held 2)` one.
- test/backlog-release-holds.test.ts: `--release` on a `(held 3)` entry removes both the note and `**Previously held 3**`; on a `(held 2)` entry it reports `not_refused` and writes nothing.
- test/doctor-backlog.test.ts: `checkStalledPlans` warns for a held-for-operator entry naming `tumwater plan --release`.
- test/team-alerts.test.ts: an `operator-held` amber alert names the entry; no such alert when the list is empty.

**Acceptance criteria.**
- The dashboard alerts and the doctor both name a held-for-operator entry and `tumwater plan --release`; a Needs-review entry below the threshold surfaces exactly as today.
- `tumwater plan --release` on a held-for-operator entry leaves no Needs-review and no `**Previously held` line behind, and the entry becomes eligible; on any other Needs-review entry it refuses without writing.
- `npm run test:gate` passes.

### Backlog hold convergence, part 3/3: Feature increments the count; the plan role carries it across a split and release clears it (planned 2026-10-23 by the plan role, split from the user's "Backlog hold convergence" plan; requires part 1/3 landed; touches src/roles/role-guidance.ts src/roles/role-catalog.ts test/role-guidance.test.ts)

**Goal.** The held count part 1/3 reads is actually written and maintained: feature appends `(held N)` with N one past the surviving prior count; the plan role carries `**Previously held N**` onto each child of a split.

**Approach.**
- src/roles/role-guidance.ts: `NEEDS_REVIEW_NOTE` and `NEEDS_REPLAN_NOTE` gain the trailing tag ` (held <N>)`; add `PRIOR_HELD_NOTE = \`${PRIOR_HELD_PREFIX}<N>**\`` beside them. `NEEDS_REVIEW_PREFIX`/`NEEDS_REPLAN_PREFIX` are unchanged (the tag is inside the line, so recognition is unaffected).
- src/roles/role-catalog.ts, feature `find` step 4: on appending a Needs-review (or Needs-replan) note, write `N = heldCount + 1`, where the prior count is read from the entry's existing `(held N)` or `**Previously held N**` line; an entry carrying neither starts at 1. State that the count must not reset while the same plan ping-pongs, and that a plan that landed and left `## Planned` needs no marker.
- src/roles/role-catalog.ts, plan `find` step 1: when the plan role lifts a Needs-review/replan note (split or rewrite) and the change has not landed, replace the note with `PRIOR_HELD_NOTE` at the same N and copy it to every child part the split produces; a landed parent leaves none. This corrects the original entry's "split resets to held 1": a split carries the count to its children, so three consecutive holds without a landing reach `(held 3)` and part 1/3's block.

**Tests.**
- test/role-guidance.test.ts (or the file already covering these exports): `NEEDS_REVIEW_NOTE`/`NEEDS_REPLAN_NOTE` each contain `(held <N>)`, `PRIOR_HELD_NOTE` contains `Previously held <N>`, and `NEEDS_REVIEW_PREFIX` still matches a tagged note line — so `heldCount` round-trips a `PRIOR_HELD_NOTE`-shaped line.
- A role-catalog test (the existing pattern for `find` texts): the feature text mentions `(held ` and the plan text mentions `Previously held`.

**Acceptance criteria.**
- A Needs-review note the feature charter writes carries ` (held <N>)`; a re-mark after one lift writes `(held 2)`, and a split's children each carry `**Previously held <N>**`.
- `NEEDS_REVIEW_PREFIX`/`NEEDS_REPLAN_PREFIX` still match the tagged notes, so `entryHold` classification is unchanged except for the count.
- `npm run test:gate` passes.

### Cancel a waiting merge from the dashboard Pending card: each merge-queue row gains a two-click Cancel, the browser twin of `tumwater queue --cancel <n>` (planned 2026-10-23 by the plan role; independent of every eligible plan — Interlock relief 1/2 edits `queuedMergeRoles` in src/merge/merge-queue.ts and src/orchestrator, the pollRunnerReasons split edits src/orchestrator, the Codex parts edit src/agent and src/prompt, `start --once --json` edits src/cli/cli-start.ts, and the Backlog hold parts edit src/backlog and src/roles; none touches src/merge/merge-cancel.ts, src/gui or src/ui/gui/gui-client-pending.ts, and this plan leaves docs/cli.md to the `start --once --json` entry; touches src/merge/merge-cancel.ts src/gui/gui-operator-commands.ts src/gui/gui-endpoint-commands.ts src/gui/gui-server.ts src/ui/gui/gui-client-pending.ts docs/how-it-works.md test/merge-cancel.test.ts test/gui-queue-cancel.test.ts (new) test/gui-client-pending.test.ts)

**Goal.** An operator who sees an unwanted change in the dashboard's Pending merge-queue card can only watch it. `tumwater queue --cancel <n>` (just landed) gives the terminal operator a way to stop it, but the browser — the surface the README leads with — has no twin: the queues on the card are read-only and a cancel means reaching for a shell. Add a two-click Cancel to each merge-queue row, backed by `POST /api/queue-cancel` on the same domain core the CLI uses, so the browser, the CLI, and the TUI cannot drift on what cancelling means.

**Approach.**
- src/merge/merge-cancel.ts: extract the removal body of `cancelQueuedMerge` (the `deleteRefIfAt` + `dropMerge` + `merge_cancelled` event + `cancelled` result) into a private `removeQueuedEntry(root, target)` so the two addressed variants cannot drift, then add `export async function cancelQueuedMergeBySha(root: string, sha: string): Promise<CancelQueuedByShaOutcome>` with `export type CancelQueuedByShaOutcome = CancelQueuedOutcome | { status: "gone" }`. It resolves the readable file in `queuedMergeFiles(root)` whose `entry.sha === sha`; none means `{ status: "gone" }` (a concurrent drain is data for the client, not an error, the `/api/prompt-cancel` gone idiom); otherwise it runs `removeQueuedEntry` and returns `cancelled`. `cancelQueuedMerge(root, position)` keeps its signature and result and calls the same helper.
- src/gui/gui-operator-commands.ts: `export async function handleQueueCancel(req, res, root)` modeled on `handleRevert` beside it. `readPostBody(req, res, '{"sha": "1a2b3c4"}')`; require `body.sha` to match `/^[0-9a-f]{4,64}$/i` else `badRequest` 400 (the `handleRevert` sha rule). Then `readMergeQueue(root)` and find the entry by sha: an absent entry answers 200 `{ ok: true, status: "gone" }` without touching disk. In-flight guard, mirroring `cmdQueueCancel` (src/cli/cli-query-commands.ts): when `queueInFlight(root, view.entries, orchestratorAlive(root))` names the sha (`inFlight.sha` or a `mergeChanges(inFlight)` record), answer 409 `{ error: 'this merge is being merged right now — wait for it to land, then `tumwater revert <shortSha>`' }` and change nothing. Otherwise `await cancelQueuedMergeBySha(root, sha)` and, on `cancelled`, answer 200 `{ ok: true, status: "cancelled", role, commit, summary, message: 'cancelled the merge of <shortSha> — <summary>' }`; on `gone`, 200 `{ ok: true, status: "gone" }` (the drain raced the click). Imports the merge/status readers the CLI branch already uses (`readMergeQueue`, `queueInFlight`, `orchestratorAlive`, `mergeChanges`, `shortSha`); update the module doc comment to name queue cancel in its list.
- src/gui/gui-endpoint-commands.ts: re-export `handleQueueCancel` from the gui-operator-commands barrel. src/gui/gui-server.ts: register `"POST /api/queue-cancel": (req, res) => handleQueueCancel(req, res, root)` beside `"POST /api/revert"`.
- src/ui/gui/gui-client-pending.ts (within the `// pending-table:start` region, so `pendingQueueHtml` stays a pure function of its args and does not reference the splice's `confirmSlot`): add a fifth optional arg to `queueEntryLineHtml(e, position, now, label, cancel)` — when `cancel` is `{ sha, armed }`, append a `<button type='button' class='btn btn-sm' data-cancel='<esc(sha)>'>` reading `Confirm cancel` when `armed` else `Cancel`; the drawer's `drawerQueueHtml` keeps calling it with four args, so the drawer markup is unchanged. Add a fifth optional `cancelArmedSha = ""` to `pendingQueueHtml(mergeQueue, now, labels, role, cancelArmedSha)` and pass `{ sha: e.sha, armed: e.sha === cancelArmedSha }` for each card row.
- src/ui/gui/gui-client-pending.ts (outside that region): `let pendingCancelSha = ""` and `const queueCancelSlot = confirmSlot(() => renderPendingQueue(lastStatus))` (the shared two-click factory defined in the roles splice, an earlier concatenated module — the drawer's entry-cancel uses the same). `renderPendingQueue` passes `queueCancelSlot.armed(pendingCancelSha) ? pendingCancelSha : ""` as the fifth argument, so a 5 s auto-disarm redraws the button as `Cancel` without extra state. In `buildPendingView`, add a click listener on `#pendingqueue` that reads `e.target.closest("[data-cancel]")` and its `data-cancel` value: an unarmed sha sets `pendingCancelSha` and calls `queueCancelSlot.arm(sha)` (which repaints); an armed sha `await postAction("/api/queue-cancel", { sha }, (d) => d && d.status === "cancelled" ? "cancelled the merge of " + shortSha(d.commit) : "that merge already left the queue")`, then clears `pendingCancelSha`, disarms, and calls `fetchPending()` so the removed row disappears at once rather than on the next status poll. `confirmSlot` and `shortSha` reach the module through the assembled script (roles and format splices, both earlier).
- docs/how-it-works.md, the dashboard Pending paragraph: state that the merge-queue card's rows each carry a two-click Cancel — `POST /api/queue-cancel`, the twin of `tumwater queue --cancel <n>` — and that a row the running team is mid-merge is refused (wait for it to land, then `tumwater revert <sha>`).

**Tests.**
- test/merge-cancel.test.ts: add `cancelQueuedMergeBySha` cases over the existing `threeQueued()` setup — cancelling the middle entry's sha removes only that file, keeps the others in order, deletes that role's pin, leaves the other pins, and logs one `merge_cancelled` event; a pin naming a different sha survives; an unknown sha returns `{ status: "gone" }` and removes nothing; the position variant still behaves as its tests pin it.
- New test/gui-queue-cancel.test.ts, modeled on test/gui-revert.test.ts (`captureJson` + `fakeReq`, `makeRepo`/`pinOffMain`, and test/cli-queue.test.ts's in-flight setup of `mergeStatePath` + an `orchestratorStatePath` naming `process.pid`): `POST /api/queue-cancel { sha }` answers 200 `cancelled` with the role/commit/summary, removes the queue file, and deletes the pin; an unknown sha answers 200 `gone` and writes nothing; a live marker naming the sha answers 409 and leaves the queue file and pin; a missing/non-hex sha answers 400 and writes nothing.
- test/gui-client-pending.test.ts: `pendingQueueHtml` with a fifth argument marks exactly the matching row's button `Confirm cancel` and the rest `Cancel`, each carrying `data-cancel='<sha>'`; without the argument every row reads `Cancel`; the drawer's `drawerQueueHtml` output carries no `data-cancel`; a malformed entry renders no `undefined`.

**Acceptance criteria.**
- Clicking a merge-queue row's Cancel twice (the first arms it, the second within 5 s posts) removes that entry from the queue and deletes its role's merge pin, and the row disappears on the redraw; a first click then a wait shows `Cancel` again.
- Cancelling a sha the running team is mid-merge is refused with the wait-then-revert wording and removes nothing; a sha no longer queued reports `gone`; a malformed body is a 400 and writes nothing.
- The endpoint and the CLI go through the same `removeQueuedEntry` removal, so `tumwater queue --cancel` and `POST /api/queue-cancel` delete the same pin and file and log the same `merge_cancelled` event shape.
- `npm run test:gate` passes.

### TUI Pending pane: up/down opens a queued merge and Ctrl+X twice cancels it, the terminal twin of `tumwater queue --cancel <n>` (planned 2026-10-23 by the plan role; independent of every eligible plan — the dashboard cancel entry edits src/ui/gui/gui-client-pending.ts, src/gui and src/merge/merge-cancel.ts but not the TUI, and this uses the already-landed `cancelQueuedMerge(root, position)` so it does not wait on that entry's sha-addressed refactor; Interlock 1/2, the Codex parts, `start --once --json` and the Backlog hold parts touch src/merge/merge-queue.ts, src/orchestrator, src/agent, src/prompt, src/cli/cli-start.ts, src/backlog and src/roles — none touches src/ui/tui; the only shared file is docs/cli.md, where this edits the TUI keys table and `start --once --json` edits the Start block, so whichever lands second rebases there; touches src/ui/tui/tui-pane-pending.ts src/ui/tui/tui-pane.ts src/ui/tui/tui-pane-session.ts src/ui/tui/tui-panes.ts src/ui/tui/tui-keys.ts src/ui/tui/tui-frame.ts docs/cli.md test/tui-keys.test.ts test/tui-frame.test.ts)

**Goal.** The Pending pane renders the durable merge queue (`renderMergeQueue`) but its rows are inert: an operator who sees an unwanted change can only press Ctrl+R and watch. `tumwater queue --cancel <n>` (landed) and the planned dashboard per-row Cancel give the other two surfaces a way to stop it; the terminal is left out. Add row selection to the TUI's merge-queue block — up/down open one row's detail, Esc returns to the list — and cancel the selected entry with Ctrl+X pressed twice, through the same `cancelQueuedMerge` core the CLI uses, so all three surfaces remove the same queue file and pin and log the same `merge_cancelled` event.

**Approach.**
- src/ui/tui/tui-pane-pending.ts: keep the visible rows as `queueRows: { entry: MergeEntry; position: number }[]` (the whole queue's `lastQueue.entries`, or `scopeMergeQueue`'s kept entries paired with `scope.positions[i]` when `roleScope` is set), rebuilt by `refresh()` and the Ctrl+G scope arm. Add `selectedQueue: number | null` and `queueDetail: string` (the selected row's rendered detail — header `merge #<position> (Ctrl+X to cancel): <roleLabel> run #<run> · <shortSha> · <age>`, then the summary and, when present, the entry's `body` and `revisionNote`). The new arms, each guarded by `session.view === session.roleIds.length + 5` and `promptLineFree(ctx.es)`:
  - up/down (via `moveEntrySelection(queueRows.length, selectedQueue, arrow)` from src/ui/tui/tui-backlog.ts) set the selection, rebuild `queueDetail`, reset `session.paneScroll = 0`, and repaint; Esc clears both.
  - Ctrl+X: with no selection, flash `select a merge with ↑↓ first`; with a selection, arm or cancel. The first press stores `session.queueArmed = { position, sha }` and flashes `press Ctrl+X again to cancel merge #<position> — any other key keeps it`. The second press (when `session.armedQueue` names the same sha) re-reads `queuedMergeFiles(session.root)` and aborts with `the merge queue changed — try again` unless the entry at the armed position still carries the armed sha; then it runs the CLI's in-flight guard — `queueInFlight(session.root, lastQueue.entries, orchestratorAlive(session.root))` naming the sha (`inFlight.sha` or a `mergeChanges(inFlight)` record) flashes the CLI's `being merged right now — wait for it to land, then tumwater revert <shortSha>` and changes nothing — then `await cancelQueuedMerge(session.root, position)`. On `cancelled` it flashes the CLI's line (`cancelled queue entry <position>: <roleLabel> <shortSha> — <summary>`) and calls `refresh()` (clearing the selection and detail); `out-of-range` flashes `that merge already left the queue` and refreshes. `reset()` clears the selection and detail on a view cycle, like the Queued pane.
  - `state()` returns `{ selectedQueue, queueDetail }` beside nothing else (the pane keeps its own cache).
- src/ui/tui/tui-pane-session.ts and src/ui/tui/tui-panes.ts: add `armedQueue: { position: number; sha: string } | null` and `queueArmed: { position: number; sha: string } | null` to `TuiPaneSession` and its initializer, and move `queueArmed` onto `armedQueue` in `beginKey` (mirroring `armedNotes`/`notesClearArmed`), so any other key disarms the second press.
- src/ui/tui/tui-keys.ts: add `selectedQueue: number | null` and `queueDetail: string` to `TuiKeysState` (merged through `...panes.state()`).
- src/ui/tui/tui-pane.ts: in the `pane.kind === "pending"` branch, when `state.queueDetail` is non-empty window it through `entryBodyWindow` and return it; otherwise keep today's `state.paneCache` path. The empty note is unchanged.
- src/ui/tui/tui-frame.ts: the Pending key list gains `["↑↓", "select merge"]` and `["Ctrl+X", "cancel merge"]`.
- docs/cli.md, TUI keys table: add a `Ctrl+X (twice) | Pending | cancel the selected queued merge ...` row naming `tumwater queue --cancel <n>` as its twin and the wait-then-revert refusal, and note the up/down selection on the existing Pending Ctrl+R row or a new row.

**Tests.**
- test/tui-keys.test.ts (the framework-free factory's harness, which already seeds merge queues with `enqueueMerge`): seed two queued entries; up/down set `selectedQueue` and fill `queueDetail` with the selected entry's role/sha/summary; Esc clears it; the first Ctrl+X arms (no disk change), the second removes only that entry (its file gone, its pin deleted, the other entry and pin intact) and logs one `merge_cancelled`; a key between the two presses disarms and changes nothing; a queue re-read between arm and confirm that moved the entry flashes the changed-queue notice and cancels nothing; a live `writeOrchestratorMarker` naming the sha flashes the wait-then-revert notice and leaves the file and pin.
- test/tui-frame.test.ts: the Pending pane's hint line names `select merge` and `cancel merge`.

**Acceptance criteria.**
- On the Pending pane, up/down open a queued merge's detail, Esc returns to the list, and Ctrl+X twice removes exactly the selected entry from the queue and deletes its role's merge pin, logging the same `merge_cancelled` shape `tumwater queue --cancel <n>` does; any key between the two presses cancels nothing.
- A selected entry the running team is mid-merge is refused with the CLI's wait-then-revert wording and nothing is removed; a queue that shifted under the selection is refused with the changed-queue notice.
- The pane goes through the shared `cancelQueuedMerge`, so criterion one's removal path cannot drift from the CLI's; the dashboard entry's sha-addressed variant, when it lands, is a separate addressing layer over the same removal.
- `npm run test:gate` passes.

### Split run-agent.ts's run lifecycle from its post-run settlement (planned 2026-10-23 by the organize role; independent of every in-flight agent entry — the Codex write-guard parts (6/9–9/9) and the Codex backend parts (9a/9–9d/9) touch src/agent/codex/*, src/prompt/dialect.ts, src/doctor/doctor-model-checks.ts and scripts/smoke-codex.mjs, not src/agent/run-agent.ts directly, and the `prepare` step that binds this file to codex already landed in part 5/9, so its contract is settled; mirrors the runner-run → runner-outcome split (linked by design but widened to run-agent's stdout/stdin/process-group concerns); touches src/agent/run-agent.ts src/agent/run-settle.ts docs/invariants.md)

**Goal.** `runAgent` is a single ~555-line async function (src/agent/run-agent.ts, 760 lines total) that both drives a backend agent to completion and settles what happened after it dies: pre-spawn setup (raw/native append logs, per-run tmpdir, marker, blind-read state, notes shim, session ledger), the async `prepare` step, spawn (env, detached group, process title, stdin pipe), incremental stdout/stderr decoding, the translator→parser→raw-log pipeline, the two watchdog clocks, and — in the `error`/`exit`/`close` handlers — the spawn-error cause, the process-group and marker orphan sweeps, the backend's post-run reconciliation, the exit-cause classification, and building the `PiRunResult` from the parser. One function owning setup, live streaming and death-handling is the largest module in the tree; it is also the single biggest obstacle to understanding any one backend's run, because the settlement half is interleaved with the feed half that precedes it. Split it on the same seam the runner split used: the run lifecycle stays where it is, the post-run settlement moves out.

**Approach.**
- src/agent/run-settle.ts (new): the post-run settlement half — the spawn-`error` handling (setupFailureResult), the `close`-handler work (flushing the decoders' held-back bytes, the translator's pending canonical lines, the backend's post-run reconciliation — opencode's session export — skipped when a killed run already settled, the exit-cause classification merging the backend's stderr verdict with the parser's event-derived flags, the blind-read failure override, and `resultFromParser` building the `PiRunResult` so adding a field touches one place), plus the `exit` orphan sweeps (the process-group sweep, then the fire-and-forget marker sweep). Each handler's body moves verbatim into a function that takes the live run state it closes over as a parameter.
- src/agent/run-agent.ts: keeps the run lifecycle — pre-spawn setup, `prepare`, spawn, decoders, stream pipeline, watchdogs, and the feed — and keeps `runAgent`/`PiRunOptions` as its exported surface. It defines a `RunSettle` binder (the shared run state: child, rawLog, parsers, decoders, watchdogs, terminateRun, finish, backend id, run marker, and the flags the handlers read live) as a type-only import for run-settle, so there is no runtime cycle; run-agent registers the `error`/`exit`/`close` listeners that delegate to run-settle's handlers.
- Move any helper only the settlement half uses (setupFailureResult, and openAppendLog if the state it returns travels only into settlement) with it; keep the type of the returned `PiRunResult` and the run's external behavior identical.
- docs/invariants.md: update the section that describes `runAgent`'s death handling (the orphan-sweep and exit-cause guarantees) to name run-settle.ts, alongside the live-reference update, in the same commit.

**Files touched.** src/agent/run-agent.ts, src/agent/run-settle.ts (new), docs/invariants.md.

**Acceptance criteria.**
- `runAgent` no longer contains the `close`/`exit`/`error` handler bodies; those live in run-settle.ts and run-agent imports them back, with no runtime import cycle (run-settle imports run-agent's binder type only).
- A grep over src/, test/ and the markdown docs for `setupFailureResult` and the moved settlement names finds no stale path or reference.
- The wipe, orphan-sweep, reconciliation and exit-cause tests that drive runAgent through the fake backend suites — test/claude-run.test.ts, test/codex-run.test.ts, test/opencode-run.test.ts, test/release-run.test.ts and test/agent-backend.test.ts — pass unchanged; `npm run test:gate` passes.

## Done
