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

### A stranded inbox prompt raises a standing alert on the dashboard, the TUI and `tumwater status`: the always-on twin of the doctor's `stale prompts` rule (planned 2026-10-23 by the plan role; independent of every eligible plan except one shared file — Backlog hold 2/3 adds its held-for-operator alert in the same `teamAlerts` function of src/ui/team-alerts.ts, so whichever lands second rebases over a neighbouring block; Interlock 1/2, Cancel dashboard and Split run-agent touch no file here; touches src/doctor/doctor-backlog.ts src/ui/team-alerts.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/tui/tui.tsx docs/how-it-works.md test/team-alerts.test.ts)

**Goal.** The doctor's `stale prompts` check (src/doctor/doctor-backlog.ts checkStalePrompts, STALE_PROMPT_MS) warns when a prompt has waited more than a day for its role to dequeue it, but only when the operator runs `tumwater doctor`. A paused, disabled or failing role never reaches the run that would dequeue it, so the prompt waits indefinitely and only the Inbox views show its age, and only when the operator looks. The stale-bug rule already has an always-on alert (`key: "stale-bugs"`, src/ui/team-alerts.ts) fed by `staleOpenBugs` on all three surfaces; give the stale-prompt rule the same treatment, at the same threshold and over the same inbox traversal, so a stranded prompt is visible in the alert banners until it is delivered or dropped.

**Approach.**
- src/doctor/doctor-backlog.ts: change `const STALE_PROMPT_MS = DAY_MS;` to `export const STALE_PROMPT_MS = DAY_MS;` and widen its doc comment to say the always-on stale-prompt alert reuses this threshold (the `STALE_BUG_DAYS` precedent). `checkStalePrompts` keeps its current filter and wording unchanged.
- src/ui/team-alerts.ts: add `export interface StalePrompt { role: string; position: number; waitedMs: number }` beside `StaleBug`, documented as the doctor's `STALE_PROMPT_MS` rule computed by `stalePrompts` (oldest-first). Widen `teamAlerts`' parameter list with a 7th `stalePrompts: readonly StalePrompt[] = []` (defaulted, so the existing six-argument callers and tests keep compiling), and add one block right after the `stale-bugs` block: `key: "stale-prompts"`, `tone: "amber"`, title `` `${plural(stalePrompts.length, "queued prompt waited", "queued prompts waited")} 1+ day for its role` ``, detail `` `inbox prompt for ${roleLabel(first.role)} #${first.position} has waited ${duration(first.waitedMs)} — the role is not dequeuing it (paused, disabled, or failing); resume or enable it, or drop the prompt with \`tumwater prompt --cancel ${first.position} --role ${first.role}\`` `` plus, when more than one, ` · ${entryListDetail(rest.map((p) => `${roleLabel(p.role)} #${p.position}`))}`, and `actions: [{ label: "Open inbox", act: "queued" }]` (the dashboard's backlog arm sets the Inbox tab). Update the module doc comment's alert list to name a stranded inbox prompt.
- src/ui/status-payload.ts: import `STALE_PROMPT_MS` from `../doctor/doctor-backlog.js` beside `STALE_BUG_DAYS`, and `queuedListRows` + `listWideScope` from `../inbox/inbox.js` and `deliverableAt` from `../inbox/prompt-not-before.js`. Add `export function stalePrompts(root: string, now = Date.now()): StalePrompt[]` beside `staleOpenBugs`, using the exact doctor filter: `queuedListRows(root, null, listWideScope(root)).filter((p) => p.queuedAtMs !== null && deliverableAt(p.notBeforeMs, now) && now - p.queuedAtMs > STALE_PROMPT_MS)` sorted by `queuedAtMs` ascending, each mapped to `{ role, position, waitedMs: now - queuedAtMs }`. Pass `stalePrompts(root, now)` as `teamAlerts`' 7th argument in `statusPayload`'s `alerts:` call.
- src/ui/status-render.ts and src/ui/tui/tui.tsx: import `stalePrompts` from the same module as `staleOpenBugs`, and pass `stalePrompts(root)` as the 7th `teamAlerts` argument in `alertLines` (status-render.ts line ~493) and the TUI attention call (tui.tsx line ~172).
- docs/how-it-works.md, the dashboard alert list ("a failing or stuck role, … a stale bug, a pause"): add "a stranded inbox prompt" so the documented list matches the alerts.

**Tests.** test/team-alerts.test.ts, both modeling the existing stale-bug tests:
- A unit test `stale queued prompts raise a standing amber alert`: `teamAlerts(base, [], [], now, [], [], [{ role: "feature", position: 2, waitedMs: 25 * 60 * 60 * 1000 }])` gives exactly one alert with `key: "stale-prompts"`, tone `amber`, a title matching `/queued prompt waited/`, a detail that starts `inbox prompt for feature #2 has waited`, includes `tumwater prompt --cancel 2 --role feature` and `paused, disabled, or failing`, and `actions` `[{ label: "Open inbox", act: "queued" }]`; two entries fold the rest through `— and 1 more`; no entries adds no alert; with both arrays set, `stale-bugs` precedes `stale-prompts`.
- An integration test `stalePrompts and the surfaces carry a stale-prompt alert from the inbox, and none without one`: seed a root whose `tumwater.json` lists `feature`, `enqueueRolePrompt(root, "feature", …)` then rename its queue file to an old 13-digit stamp (the `promptRoot`/`stampPrompt` helpers in test/doctor-backlog.test.ts); assert `stalePrompts(root, now)` names `{ role: "feature", position: 1 }`, and `statusPayload(root, now).alerts` carries `key: "stale-prompts"`; a prompt stamped exactly 24 h ago (not strictly past it) and a `--at` prompt whose `notBefore` is still in the future each add no alert.

**Acceptance criteria.**
- A prompt due-but-undelivered for more than `STALE_PROMPT_MS` produces one amber `stale-prompts` alert on all three surfaces (the dashboard's `GET /api/status` alerts, the TUI attention lines, and `tumwater status`), naming the oldest prompt's role and position, its wait, and the deliver-or-drop commands; a deferred prompt still counting down and a prompt at or under the threshold produce none.
- The alert and the doctor's `stale prompts` check share `STALE_PROMPT_MS` and the same `queuedListRows`/`listWideScope`/`deliverableAt` traversal, so the rule and its threshold cannot drift.
- `npm run test:gate` passes.

### `tumwater start --for <duration> --json` prints the window's per-role summary as one JSON object, so a scripted window run does not parse the prose table (planned 2026-10-23 by the plan role; independent of every eligible plan — Interlock 1/2 edits src/merge and src/runner, Interlock 2/2 edits docs/how-it-works.md, Backlog hold 2/3 and the stranded-inbox alert edit src/ui/team-alerts.ts, Backlog hold 3/3 edits src/roles, and Split run-agent edits src/agent; none touches src/cli/cli-start.ts, src/cli/help.ts, docs/cli.md or these tests; touches src/cli/cli-start.ts src/cli/help.ts docs/cli.md test/cli-start.test.ts test/cli-start-guards.test.ts test/cli-start-once.test.ts test/cli-start-window.test.ts)

**Goal.** `tumwater start --once --json` prints a round as one JSON object for a cron/CI caller. The other scripted boot, `--for <duration>`, prints only a prose window line and the `history --summary` table (`windowSummary`, src/cli/cli-start.ts), so an overnight or CI window run whose caller wants the counts must scrape that table. Give `--for` the same machine contract: `--json` with `--for` prints the window's per-role summary as one JSON object on stdout at exit and nothing else.

**Approach.**
- src/cli/cli-start.ts, `cmdStart`: widen the `--json` gate from `if (json && !once) fail("--json is only valid with --once")` to `if (json && !once && forMs === null) fail("--json is only valid with --once or --for")` (`forMs` is already parsed above it).
- src/cli/cli-start.ts, `cmdStart`: refuse `--json` with the two interactive modes, which write their own banner to the stdout the JSON document must own — `if (json && args.includes("--gui")) failRivalShapes("--json", "--gui", "the dashboard writes its banner to the stdout a JSON document must own")`, and the same for `--tui` ("a TUI owns the terminal"). Place both right after the widened gate, so a `--for --json --gui`/`--tui` fails before any boot.
- src/cli/cli-start.ts: add `export interface WindowReport { window: string; covered: boolean; roles: HistorySummaryRow[]; total: HistorySummaryRow }` and `export function windowReport(label, summary, covered): WindowReport` beside `windowSummary`, returning `{ window: label, covered, roles: summary.roles, total: summary.total }`. Unlike `windowSummary` it does not append `SPARSE_WINDOW_NOTE`; `covered: false` is the fact a script reads.
- src/cli/cli-start.ts, the `else if (forMs !== null && !exit.restart)` branch: build `const summary = summarizeRunRows(rows)` once, then `if (json) sayJson(windowReport(durationLabel(forMs), summary, covered)); else say(windowSummary(durationLabel(forMs), summary, covered))`.
- src/cli/cli-start.ts: guard the two stdout writes that would otherwise share the document — the deadline line becomes `if (!json) say("deadline reached — stopping")`, and `superviseStartCommand`'s `onRespawn` restart line gains `&& !runArgs.includes("--json")` (the supervisor process reads `--json` from `runArgs`). The banner and event subscription are already `json`-guarded.
- src/cli/help.ts: on the `--for` bullet add `--for --json prints the window's per-role summary as one JSON object on stdout at exit (no banner or event stream); --json with --gui or --tui is refused;`, and change the `--once --json` sentence's tail `; only valid with --once;` to ` (the --once report; --json is refused without --once or --for);`.
- docs/cli.md: line 26's `--for 2h` usage comment gains the `--json` form (`tumwater start --for 2h --json`), and line 29's `(only with --once)` becomes `(only with --once or --for)`.

**Tests.**
- test/cli-start.test.ts: a `windowReport` unit test beside the `windowSummary` tests — over `summarizeRunRows` of a two-row fixture, `windowReport("2h", summary, true)` deep-equals `{ window: "2h", covered: true, roles: summary.roles, total: summary.total }`; a `covered: false` call carries `covered: false` and no `SPARSE_WINDOW_NOTE` text.
- test/cli-start-once.test.ts: the existing "run --json without --once is refused and boots nothing" test's regex becomes `/--json is only valid with --once or --for/`; its body is otherwise unchanged.
- test/cli-start-guards.test.ts: `run --for 1s --json --gui` and `run --for 1s --json --tui` each fail before boot with the rival-shapes message naming `--json` and the interactive flag (same `initProject` + `withPi("exit 0")` pattern as the neighbouring guards).
- test/cli-start-window.test.ts: a `run --for 3s --json` test mirroring the existing prose `--for 3s` one (including its pre-window `ghost` run), asserting after the exit-0 child that `JSON.parse(s.out().trim())` is an object with `window === "3s"`, `typeof runs === "number"`, `typeof covered === "boolean"` and `Array.isArray(roles)`, and that stdout carries no `tumwater running on branch`, no `deadline reached — stopping`, no `stopping — finishing current runs`, and no `ghost`.

**Acceptance criteria.**
- `tumwater start --for <duration> --json` prints exactly one JSON object on stdout at exit and nothing else — no banner, no event stream, no deadline/stop prose, no window table — printed once by the final generation (an early Ctrl+C prints it too); its `window`, `covered`, `roles` and `total` match what `windowSummary` renders from the same rows.
- `tumwater start --for <duration>` without `--json` prints today's prose window line and table unchanged; `--json` without `--once` or `--for`, and `--json` with `--gui` or `--tui`, are refused before any boot.
- `npm run test:gate` passes.

## Done
