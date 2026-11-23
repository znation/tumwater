# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### `reset-counters --role <base>` / `wake --role <base>` reach a role's whole instance family only while a team is live, so the same command on a stopped team leaves every instance row dirty (found by the qa role 2026-11-23)

**Symptom.** With no team running, `tumwater reset-counters --role feature` prints `counters reset for feature` and zeroes only `.tumwater/state/feature.json`; the `feature #2` row `tumwater status` still shows keeps its runs, commits, tokens and cost. The identical command with a live team zeroes the whole family, because the marker consumer fans a base id out through `baseRole` — docs/invariants.md INV-AQ5 states it outright: "A base id in the marker still reaches every instance of it while the team is live." Same command, same confirmation line, different result depending on whether a fleet happens to be up. `tumwater wake --role <base>` has the same shape offline: instance 2 keeps its backoff and its future `nextRunAt`, so the `tumwater start` the confirmation promises runs instance 1 immediately and leaves instance 2 sleeping out its old schedule. The dashboard is hit through the same path: the Roles card's **Reset counters** button posts `{}`, which `configuredRoleIds` resolves to the base ids only (INV-AQ5 pins that list as `resetTargetRoles`' base-id subset), and its own button title promises "Zero every role's runs, commits, tokens, and cost" — with no team running, every instance row survives it. The 2026-11-21 fix (BUGS-FIXED.md, "Offline `tumwater reset-counters` with no `--role` zeroes only base roles") widened only the bare form; `--role` and the endpoint kept the base-only write.

**Reproduce** (scratch dir, never the team's own `.tumwater`):
1. `mktemp -d`, `git init -b main`, `tumwater init "repro"`.
2. Seed the family with the same nonzero counters — `.tumwater/state/feature.json` and `.tumwater/state/feature-2.json`: `"runs":7,"commits":2,"generatedTokens":30000,"totalCostUsd":1.5` (other fields as `tumwater` wrote them).
3. `tumwater status --role feature`: both rows read 7 / 2 / 30.0k / $1.50.
4. `tumwater reset-counters --role feature` → `counters reset for feature — takes effect on the next \`tumwater start\` (tumwater is not running)`.
5. `tumwater status --role feature` again: `feature` reads 0 / 0 / 0 / $0.00, `feature #2` still reads 7 / 2 / 30.0k / $1.50, and `feature-2.json` on disk still carries `runs:7 … totalCostUsd:1.5`. `.tumwater/reset-counters.json` holds `"roles":["feature"]`.
6. Control: `tumwater reset-counters --role feature-2` zeroes that file (runs 0, cost 0), so the explicit-instance path works.
7. Endpoint twin, same repo with no team running: `tumwater gui --port <ephemeral> --token <t>` (bound to 127.0.0.1, killed after), then `curl -X POST "http://127.0.0.1:<port>/api/reset-counters?token=<t>" --data '{}'` answers `ok:true` with a message naming only the 18 base ids, and `feature-2.json` keeps `runs:9 … cost:2.5` (reseeded before the call).
8. `wake` twin: seed `.tumwater/state/feature.json` and `feature-2.json` with `backoffSeconds:600, nextRunAt:now+600000`; `tumwater wake --role feature` → `feature` reads `backoffSeconds:0` with `nextRunAt` in the past, `feature-2` still reads `backoffSeconds:600` with `nextRunAt` in the future.

**Cause.** `requestResetCounters` (src/operator/operator-intent.ts:83) writes the state files directly when no team is live, over exactly the ids it was handed: `for (const r of roles) saveRunnerState(root, zeroCounters(loadRunnerState(root, r)))` — no instance expansion. `requestWakeOutcome` (same file) clears the schedule the same way over the named ids only. The live path never touches the files: `roleRequestTargets` (src/operator/operator-requests.ts:44) keeps a runner when `requested.includes(r.role) || requested.includes(r.baseRole)`, so one base id covers the family — pinned for wake by test/operator-requests.test.ts ("consumeWakeRequest wakes every instance of a named base role and the current id of a legacy one"). `runnerlessTargets` (same file, line 69) filters the same way, so even the runnerless fallback reaches a requested instance id, never a base-named sibling. Only the offline direct-write arm lacks the expansion. `baseRoleOf` and `runnerIds` are already imported in operator-intent.ts, so the fix needs no new dependency.

**Expected.** With no team running, `--role feature` zeroes `feature` and every runner id of `feature` the config says should exist, exactly as a live team would; likewise `wake --role feature` clears every instance's backoff and `nextRunAt`. **Fix direction:** expand each named base id through `runnerIds(loadConfig(root))` where the offline arm writes state (one helper shared by both marker cores, so reset and wake cannot drift), leaving the marker payload and INV-AQ5 untouched — a base id in the marker already means the family. `--json`'s `roles` (docs/cli.md: "the resolved targets") may widen to name the ids actually written, which is what bare `reset-counters` already prints; whichever shape is chosen, pin it in the ack. Tests: seed an instance state file and assert the offline `--role <base>` form zeroes it (the 2026-11-21 regression test covers only the bare form), and assert the offline `wake --role <base>` form zeroes the instance's `backoffSeconds`/`nextRunAt`; keep the live-path tests untouched — they already pin the fan-out. Do not widen `targetRoles` (wake's bare default), which the 2026-11-21 entry deliberately left as the config's base ids.

**Validation gap:** no-observability — the offline arm's confirmation and `--json` name only the base id, which is true of the marker and false of the write, so nothing an automated check reads disagrees with the dirty instance row until a human cross-reads the live and offline arms.

### An event type added to the `HarnessEvent` union is forced to have a label by tsc but its digest classification is checked only by a runtime test the budgeted gate may skip, so new event types land main red on that guard (found by the selfcheck role 2026-11-23)

**Cluster.** `check failed (npm run test:gate): ✖ every event type is replayed or explicitly excluded — …`
(1×, feature-3, 11-22, post-merge rejection — so the commit had already reached main). The same guard held main red
twice on 2026-11-21, verified by a first-parent walk comparing `git show <c>:src/events/event-labels.ts` against
`git show <c>:src/failure/failure-state-change.ts` at every commit: `55f36129d` (12:40, "Scan open GitHub issues
hourly into a mirror-state ledger") and `f46a13980` (12:44, "Log a review_dropped event when a post-merge review is
dropped") left it red until `5928d5538` (12:55, coverage #1001, "Classify review_dropped and github_issues_unavailable
in failure-state-change") — 15 minutes — and `d4ea1c618` (13:05) reddened it again
through `f27753fd5` (13:16) and `77fff10b3` (13:47) until `ae80f726f` (14:14, ci #255, "Classify new github_issue_*
events …") — 69 minutes. Those five merged commits each added an event type named in neither
`STATE_CHANGE_FAMILY` nor `STATE_CHANGE_EXCLUDED_TYPES`; none classified its own type.

**The wrong response (why this is a bug, not weather).** The label half of that guarantee is compile-enforced:
`EVENT_TYPE_LABELS: Readonly<Record<HarnessEvent["type"], string>>` (src/events/event-labels.ts:11) makes a missing
label a build error, so every one of those commits had its label. The classification half is
`Partial<Record<HarnessEvent["type"], (ev: HarnessEvent) => string>>` (src/failure/failure-state-change.ts:30-31),
so a missing entry is legal TypeScript, and the only thing that fails on it is one runtime test
(test/failure-state-change.test.ts:73, "every event type is replayed or explicitly excluded"). The merge gate runs
`npm run test:gate` = the affected tests under a 20 s budget, so the guard that a change is one import hop from
runs only if the budget happens to leave room for it: the change passes its own gate, main goes red, and the repair
is a separate ci or coverage run that re-derives the cause from scratch. The digest prices that repair: coverage
#1001 took 33 turns and ci #255 47 turns (their own WHY lines say the full check catches what the gate's
affected-only run misses), and the 11-22 occurrence reached a post-merge rejection at all — a commit already on
main, which is never re-reviewed.

**Reproduce.** Offline and deterministic, no model: replay the selection over each of the five commits' changed-file
lists with the current test-cost ledger. The guard ranks at distance 1 for all five, and `fitBudget` leaves it in
`fit.left` for `77fff10b3`'s list (7 test files run, 19 994 ms of the 20 000 ms budget, 10 118 ms of it already
spent on the `POLICY_SCANS` scans) while it fits inside the budget for the other four lists today. Whether the
guard runs therefore depends on the cost ledger of the moment, not on the change — that is the defect.

**Fix direction.** Move the guarantee from the budgeted test to the compiler, where it costs the gate nothing: make
the classification one exhaustive object literal keyed by every event type —
`Record<HarnessEvent["type"], ((ev: HarnessEvent) => string) | null>` with `null` naming a deliberately excluded
type — and derive `STATE_CHANGE_TYPES` (from the function entries) and `STATE_CHANGE_EXCLUDED_TYPES` (from the
`null` entries) from it. A new union member is then a tsc error until its author classifies it, exactly as the
label already is. That shape also closes a live defect the current guard cannot see: `github_issues_unavailable` is
listed twice in the excluded set's literal (src/failure/failure-state-change.ts:125 and :148), `new Set` collapses
the duplicate, and the test's partition assertion passes over it — a repeated key in an object literal is a compile
error. Keep test/failure-state-change.test.ts:73 as the runtime pin over the derived sets.

**Not this fix.** Registering `test/failure-state-change.test.ts` in `POLICY_SCANS` — the fix that closed the same
family in BUGS-FIXED.md's "The self-scan guard for the tmpdir rule is not in `POLICY_SCANS`, so the budgeted gate
passes over it and a change that adds offenders lands main red" (found 2026-11-17, fixed 2026-11-19) — would spend
the guard on every gate whatever the change touches; that family's guard is genuinely repo-wide, this one is
distance-1 to the file the change already had to edit. Raising the budget is off the table: QUESTIONS.md's "Should a
change to a widely read default run more than the budgeted gate?" (asked by the plan role 2026-11-21) was answered
the same day with option (a), keep the 20 s trade-off. The compile-time route keeps that trade-off and removes the
failure.

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
- 2026-11-22 run (real): fresh `npm run build` of worktree tip 30cb5dd1 + `init "Build a tiny markdown-to-html converter CLI in Python."` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` + `config set maxConcurrent 1` + `config unset bootstrap` + `start --once --role feature --json` (with `TUMWATER_SUPERVISOR_PID`/`TUMWATER_SUPERVISED`/`TUMWATER_RUN` stripped from the environment) — one real run on OpenCode's free DeepSeek tier: `{"runs":1,"outcomes":{"no_change":1},"skipped":[],"failures":[]}`, exit 0, 29s, 871 output tok (prompt 46.5k tok, 67% cached), $0.00; `status` printed the 20-row role table with the documented `Declaring a build check` info alert and `budget: n/a` for an all-free team, `doctor --problems` printed `ready to run` with `70 ok checks hidden`, and `history`, `history feature --last` and `report` matched docs/cli.md; no tumwater or opencode process outlived the round and the scratch dir was deleted.
- 2026-11-17 run (real): fresh build of worktree tip 1fc125aa + `init` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` (the free no-login OpenCode tier) + `start --once --role feature --json` — exactly one real run on opencode's free DeepSeek, a `no_change` round (943 tok, $0.00, ~51s), exit 0, clean `orchestrator_start`/`stop` with no leaked process; `status` feature row (1 run, $0.00, `no change`) + the documented `No build check declared` alert + the 16-row role table all match README/docs, and `logs` confirms `run #1 started on opencode/deepseek-v4.1-flash-free` → `no change · 943 tok`.
