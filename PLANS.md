# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Subtract, part 6a/6: The live docs and example config keep only the mechanisms that survived the series (planned 2026-11-02 by the plan role, splitting the 2026-10-26 too-large sweep part 6/6 after feature held it; sibling to Subtract part 6b/6, independent in files of it; design in plans/subtract.md "The six strokes" and "How we will know it worked"; its original prerequisites Subtract parts 1e/6, 5v/6 and 5x/6 have landed, and it requires Subtract part 3g/7 landed, the last unlanded Subtract part; touches docs/config.md docs/cli.md docs/glossary.md docs/how-it-works.md docs/invariants.md README.md DEVELOPMENT.md tumwater.example.json)

**Goal.** The live prose and `tumwater.example.json` describe only mechanisms that still exist after the Subtract series: the names whose producer and reader the earlier parts removed are gone from the config tables, command lists, glossary, architecture prose and example config, while every mechanism the user kept is still documented and its keys still appear. This is the documentation half of the old sweep; the doctor rows, tests and before/after counts are part 6b/6.

**Approach.** All edits are documentation and the example config; no `src/` file changes here.
- Treat the old sweep list as a candidate list, not a mandate: for each name, `grep -rn '<name>' src/` first. A name whose live `src/` reader or writer is gone is removed from the swept docs and the example; a name `src/` still reads or writes stays documented with its tests. The pre-merge gate keeps its build check (user, 2026-11-01), so in particular `check_wait` and `maxConcurrentChecks` stay wherever the check permit still serves that gate or the main watch, and `mergeCommand` stays wherever the merge step still reads it. `mergeBatchMax` is dead after the batch path landed; `maxConcurrentPerProvider`, `claudeWindowReserve`, `windowReserve`, `review.afterMerge`, `held-for-operator`, `Needs replan`, `Waiting for the next failure` and the `(held N)` counter are dead. The queue vocabulary (`merge queue`, `interlock`) belongs to the landed part 3g/7; remove any occurrence this file still carries.
- docs/config.md: drop the dead keys and aliases from the tables, and keep the rows for the keys `src/config/config-schema.ts` still reads — `instances`, `slotCount`, `slot_wait`, `slot salvage`, the tier/fallback keys, the image reroute and the subscription usage-window display (the Settings concurrency controls and those mechanisms were kept: director 2026-10-31, user 2026-10-28 and 2026-10-30).
- docs/cli.md and the TUI-keys table: drop commands, flags and keys whose implementation parts 3d/7–3f/7 removed, and keep the concurrency controls and declared-check editing that remain. docs/glossary.md: remove the terms for deleted mechanisms and keep the kept vocabulary.
- docs/how-it-works.md: remove paragraphs that still promise a deleted stage, queue or alert; keep the gate's pre-merge build check and the Hourly full check's hourly main watch as landed.
- tumwater.example.json: remove only the dead keys; preserve the kept capacity, tier, fallback, image-reroute and subscription-window settings.
- docs/invariants.md: drop or re-scope the invariants of deleted subsystems (merge-slot stages, the permit where its mechanism is gone, per-provider caps, subscription-window holds), keep the invariants of the tiers, budget fallback, image reroute and subscription usage-window display, and leave every remaining file/test binding naming an existing file and test.
- README.md and DEVELOPMENT.md: remove stale references to the deleted mechanisms; do not touch the brief block between the `tumwater:prompt` markers.

**Files touched.** docs/config.md docs/cli.md docs/glossary.md docs/how-it-works.md docs/invariants.md README.md DEVELOPMENT.md tumwater.example.json

**Acceptance criteria.**
- For every candidate name, the part's Done entry records the `grep` evidence: either no live `src/` reader remains and the name is absent from the swept docs and example, or a live reader remains and the name is still documented with that reader.
- `grep -rnE 'maxConcurrentPerProvider|mergeBatchMax|claudeWindowReserve|windowReserve|review\.afterMerge|held-for-operator|Needs replan|Waiting for the next failure' docs/ README.md DEVELOPMENT.md tumwater.example.json` prints nothing.
- `grep -rniE 'merge queue|queue stage|verify stage|approval stage|requeue|queue depth' docs/ README.md` prints no claim about a mechanism the landed parts deleted.
- The kept mechanisms are still documented: the Settings concurrency controls, the tier and budget-fallback settings, the image reroute and the subscription usage-window display, plus any check-permit key `src/` still reads.
- docs/invariants.md keeps no binding to a deleted module and no binding whose named test file is gone; docs/config.md, docs/cli.md and the TUI-keys table agree with the live schema and command set.
- `npm run test:gate` passes.

**Tests.** Run test/config-doc.test.ts (docs/config.md against the live schema), test/cli-doc.test.ts and test/docs-commands.test.ts (command help/docs parity), test/tui-keys-doc.test.ts, test/docs-links.test.ts and test/invariants-doc.test.ts (file and test bindings), then the project's gate. If a kept key is dropped from the docs or a dead key stays, fix the table; do not weaken a doc check.

### Subtract, part 6b/6: The doctor rows, tests and counts the series left behind (planned 2026-11-02 by the plan role, splitting the 2026-10-26 too-large sweep part 6/6 after feature held it; sibling to Subtract part 6a/6, requires Subtract part 6a/6 landed so the surviving key and row set is fixed; touches src/doctor/doctor-check-names.ts test/doctor-checks.test.ts test/event-format.test.ts test/retention.test.ts test/config.test.ts PLANS.md)

**Goal.** The doctor advertises only checks whose mechanism still exists, and the tests assert only surviving rows, events, artifacts and keys. This is the code-and-tests half of the old sweep; the live docs and example config are part 6a/6, whose surviving set this part follows. The part also records the series' before/after row and key counts and its measurement table.

**Approach.** All edits are the doctor row list and the tests that pin it; no production behavior changes.
- src/doctor/doctor-check-names.ts: delete the rows whose check function no longer exists after the series; do not re-point them at another mechanism. Keep every row whose check still reads a live path. Do not add a row.
- Re-check the parts 1a–1e/6 rule end to end: every condition that used to have a banner and now has no banner still has a doctor row, and every row names a mechanism that exists. Record any condition with neither a banner nor a row in the part's Done entry rather than inventing a row here.
- test/doctor-checks.test.ts: update its row list to exactly the surviving rows; delete cases whose only subject is a deleted row. test/event-format.test.ts: delete the cases for event types no live producer emits (including `check_wait` only when part 6a/6 found no live reader, and the merge-stage events the landed parts removed); keep the cases for surviving event families. test/retention.test.ts: delete the cases for artifacts no mechanism writes; keep the surviving ones. test/config.test.ts: update the key cases to the surviving key set part 6a/6 documented; do not delete a case for a key `src/config/config-schema.ts` still reads.
- In the part's PLANS-DONE entry, record the doctor row count and the config key count before this part and after it, and carry the measurement table from plans/subtract.md "Before deleting concurrency and model policy".

**Files touched.** src/doctor/doctor-check-names.ts test/doctor-checks.test.ts test/event-format.test.ts test/retention.test.ts test/config.test.ts PLANS.md

**Acceptance criteria.**
- Every row name in `doctor-check-names.ts` resolves to a check function that exists and reads a mechanism that still exists; no row reports a path nothing writes.
- The row list in test/doctor-checks.test.ts equals the surviving row set; no test asserts a deleted row, event type, artifact or config key, and the surviving cases stay.
- No production module outside `src/doctor/doctor-check-names.ts` changes; that edit only adds or removes row-name strings, and the diff names only the files listed above.
- The before/after doctor row and config key counts and the measurement table are in the part's PLANS-DONE entry.
- `npm run test:gate` passes.

**Tests.** Run test/doctor-checks.test.ts, test/doctor.test.ts, test/event-format.test.ts, test/retention.test.ts, test/config.test.ts and test/config-aliases.test.ts, then the project's gate. If a surviving row or key loses its case, restore it; do not weaken an assertion to make the gate pass.

### Subtract, part 3e/7: A run's merge pin is merged directly, without a queue entry (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract part 3d/7 landed; touches src/run/run-stage.ts src/runner/runner-leftover.ts src/orchestrator/orchestrator-poll.ts src/merge/merge-core.ts docs/how-it-works.md test/run-stage.test.ts test/runner-leftover.test.ts test/orchestrator-merge-pin.test.ts)

**Needs review 2026-11-08 by feature: too large for one run** — the pin-only change cascades beyond the listed files: test/runner-leftover-recovery.test.ts's recovery e2e and test/fixtures/orchestrator-fixtures.ts's `mergeHead` both drive a queue entry (queueDepth/headMerge), so they need rework; the merge drain's one-at-a-time slot and startMerge/settle/requeue in src/merge/merge-drain.ts, merge-pipeline.ts and merge-slot.ts must accept a null queue file and suppress requeue for a kept pin; and the drain needs a pin reader (pinnedRetrySha + recoveredMetadata + recoveredMergeEntry) with stale/conflict-cap handling.

**Goal.** New work stops writing a durable queue entry: a run pins its commit by `refs/tumwater/landing/<role>` and the orchestrator merges that pin on a poll. The queue reader still drains files an older build left, so the two paths coexist until part 3f deletes the queue.

**Approach.**
- In run-stage.ts, replace the `enqueueMerge` block with the pin only: after `pinAndReset`, log `merge_queued` with the commit and summary and end the run `queued` exactly as today; `heldOnBranch` still checks an existing pin. Remove the queue-entry construction from the fresh path; keep the revision trailer on the commit so a recovered pin still carries its round.
- In runner-leftover.ts, replace the `enqueueMerge` call with the same pin-only return (`{ kind: "pinned", sha, summary }`): adopt an unpinned branch tip into the merge ref as today, but write no queue file. Keep stale/dangling pin cleanup, the conflict hand-back and `MERGE_CONFLICT_LIMIT`.
- Add the pin merge to orchestrator-poll.ts: for each runner with `hasUnmergedPin` and no in-flight merge, read `recoveredMetadata` for the pinned sha and call the merge path (`mergeApprovedChange`) under the existing merge lock; a merged pin is deleted, a conflicting pin is kept for the existing leftover/conflict hand-back path, and a pin main already contains is dropped.
- docs/how-it-works.md's Merge section says a pin is the waiting state; the durable queue is legacy input only.

**Files touched.** src/run/run-stage.ts src/runner/runner-leftover.ts src/orchestrator/orchestrator-poll.ts src/merge/merge-core.ts docs/how-it-works.md test/run-stage.test.ts test/runner-leftover.test.ts test/orchestrator-merge-pin.test.ts

**Acceptance criteria.**
- A fresh run that commits writes a pin and no `.tumwater/merge-queue/` file; its log path is still `merge_queued → merged` and its change reaches main after its one gate check, with no second check.
- A pin left by a crash or an earlier build is merged on the next poll; a pin whose commit main already contains is deleted without merging.
- A conflicting pin is kept once and hands back to its author at `MERGE_CONFLICT_LIMIT`, not retried forever.
- Old queue files still drain through the pre-3e path until part 3f removes it.
- `npm run test:gate` passes.

**Tests.** New test/orchestrator-merge-pin.test.ts: a pin is merged on a poll, a stale pin is dropped, a conflict keeps the pin and records the streak. test/run-stage.test.ts: a committed run pins and enqueues nothing. test/runner-leftover.test.ts: recovery adopts a tip into the pin and writes no queue file. Run those files and the gate.

### Subtract, part 3f/7: The durable merge queue and its status/doctor readers go (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract part 3e/7 landed; touches src/merge/merge-queue.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-slot.ts src/merge/merge-requeue.ts src/status/status-data.ts src/status/status-roles.ts src/status/status-polls.ts src/doctor/doctor-backlog.ts src/doctor/doctor-check-names.ts src/doctor/doctor-holds.ts src/gates/gate-polls.ts src/scheduling/once-round.ts src/events/event-notify.ts docs/how-it-works.md test/merge-queue.test.ts test/merge-requeue.test.ts test/merge-slot.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/doctor-checks.test.ts test/status-data.test.ts test/status-roles.test.ts test/once-round.test.ts)

**Goal.** With part 3e writing no queue file, the queue, its pipeline, slot and requeue modules are dead state. Delete them and re-point every reader at the pin/in-flight marker: status shows a role's waiting pin, the doctor drops the two merge-queue rows, and `once --once` waits on no in-flight merge instead of an empty queue directory.

**Approach.**
- Delete src/merge/merge-queue.ts, merge-drain.ts, merge-pipeline.ts, merge-slot.ts and merge-requeue.ts; move the one in-flight marker type/reader the new pin path and post-review drain still need into a small module beside merge-core.ts, and delete `.tumwater/merge-queue/` handling (`mergeQueueDir`, `legacyLandQueueDir`, the startup migration step) from src/paths.ts and startup-migration-steps.ts.
- status-data.ts's `readMergeQueue` block and `queuedRoles` become the pin/in-flight set; status-roles.ts and status-polls.ts read that set. Delete the queue header badge, the queue depth and the per-role queued row that name a now-nonexistent directory.
- doctor-backlog.ts loses `checkStaleQueuedMerges` and `checkMergeQueueFiles`; doctor-check-names.ts drops `stale merge-queue entries` and `merge-queue files`; doctor-holds.ts reads the in-flight/pin set instead of the queue.
- gate-polls.ts and scheduling/once-round.ts read the in-flight/pin state for their `queued` counts instead of `queuedMergeRoles`/`queuedMerges`; once-round's `queuedMerges: number` becomes the pin count.
- events/event-notify.ts drops notifications that name queue files (`unreadable queue files`, `merge-queue file`), keeping `merge_queued`/`merged`.
- docs/how-it-works.md removes the queue directory, stages and queue doctor rows, describing pins and the in-flight marker instead.

**Files touched.** src/merge/merge-queue.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-slot.ts src/merge/merge-requeue.ts src/status/status-data.ts src/status/status-roles.ts src/status/status-polls.ts src/doctor/doctor-backlog.ts src/doctor/doctor-check-names.ts src/doctor/doctor-holds.ts src/gates/gate-polls.ts src/scheduling/once-round.ts src/events/event-notify.ts src/paths.ts src/orchestrator/startup-migration-steps.ts docs/how-it-works.md test/merge-queue.test.ts test/merge-requeue.test.ts test/merge-slot.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/doctor-checks.test.ts test/status-data.test.ts test/status-roles.test.ts test/once-round.test.ts

**Acceptance criteria.**
- `grep -rn 'merge-queue\|mergeQueue\|queuedMerges\|readMergeQueue\|mergeQueueDir' src/` finds no live queue path; `docs/how-it-works.md` names no queue directory or stage.
- `tumwater status` shows each waiting role's pin and in-flight merge; the doctor's `stale merge-queue entries` and `merge-queue files` rows are gone rather than warning about a path nothing writes.
- `once --once` treats a waiting pin as unsettled work and exits only after its merge settles, the same way it treated a non-empty queue.
- No module imports a deleted merge-queue/merge-drain/merge-slot/merge-requeue file; the compiler is clean.
- `npm run test:gate` passes.

**Tests.** Delete test/merge-queue.test.ts, test/merge-requeue.test.ts, test/merge-slot.test.ts and the queue-specific cases in test/merge-pipeline*.test.ts; update test/status-data.test.ts, test/status-roles.test.ts, test/doctor-checks.test.ts and test/once-round.test.ts to pins/in-flight. Run those files and the gate.

### Subtract, part 3g/7: Docs and invariants say one lock, linear history and a post-landing check (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract part 3f/7 landed; touches docs/how-it-works.md docs/invariants.md docs/glossary.md README.md test/invariants-doc.test.ts test/merge-backlog-conflicts.test.ts)

**Goal.** The live prose and the invariant bindings describe the landing that exists after parts 3a–3f: a pin, a rebase under the merge lock, a fast-forward, and the main watch's post-landing full check. No sentence promises queue stages or an approval step; the pre-merge gate keeps its build check (user, 2026-11-01), so the docs keep saying so.

**Approach.**
- Sweep the queue vocabulary out of docs/how-it-works.md, docs/invariants.md and docs/glossary.md: merge queue, queue stage, verify/approval stage, batch/bisect (already gone), retry/requeue, queue depth and queue cancel/top.
- In docs/invariants.md, drop or re-scope every binding to a deleted module (`merge-queue`, `merge-verify`, `merge-batch`, `merge-slot` stages, `merge-requeue`) and state the surviving guarantees: one merge writer under one lock, linear history, a deleted pin on merge and the main watch's post-landing checks as docs/how-it-works.md states their cadence at the time (amended 2026-11-01 by the operator: the pre-merge gate keeps its build check, and the Hourly full check series moves main's full check to at most hourly on the latest tip, so this part must not restate "a full check per commit"). Keep the conflict-hand-back and review-gate bindings that still have code.
- README's status line stays as is; remove any queue wording elsewhere in README.
- Re-check docs/invariants.md's file-to-test bindings: every remaining binding names a file and a test that still exist; the invariants-doc test enforces it.

**Files touched.** docs/how-it-works.md docs/invariants.md docs/glossary.md README.md test/invariants-doc.test.ts test/merge-backlog-conflicts.test.ts

**Acceptance criteria.**
- `grep -rniE 'merge queue|queue stage|verify stage|approval stage|requeue|queue depth' docs/ README.md` finds no claim about a mechanism parts 3a–3f deleted (the archive files PLANS-DONE.md and BUGS-FIXED.md are excluded by construction).
- Every docs/invariants.md binding that names a merge module names a file and a test that still exist; deleted-module INVs are gone, not re-pointed.
- The surviving prose says: a change is pinned, gated (the diff rules and the declared gate command), merged by rebase and fast-forward under the merge lock, and covered on main by the main watch's full check.
- `npm run test:gate` passes.

**Tests.** Run test/invariants-doc.test.ts and test/merge-backlog-conflicts.test.ts whole, then the project's gate, and confirm green.

### `tumwater plan --list --grep --show` and its bug twin filter for the literal `--show` instead of entering the detail view, so a flag-shaped pattern behaves like every other `--grep` (planned 2026-11-08 by the plan role; `runBacklogCommand` in src/cli.ts routes on `args.includes("--show")` before its `--list` branch, so the token after `--grep` is claimed as the detail mode before `listAndAnnounce`'s `parseListArgs` (src/cli/cli-backlog-view.ts) can consume it as the pattern; `tumwater plan --list --grep --show` and `tumwater bug --list --grep --show` exit 1 with `--show needs a position number (e.g. \`--show 2\`)`, while `--grep --cancel`/`--edit`/`--retire` are safe because the `--list` branch precedes those and `--grep --list` still finds a real `--list`; the identical hazard is already guarded for `reviews` (`cmdReviews`'s `modeNamed`), `quarantine` (`cmdQuarantine`) and `salvage` (`cmdSalvage`), which ignore the token immediately after `--grep`; `grep -n 'modeNamed' src/cli.ts` prints nothing, and no PLANS.md or PLANS-DONE.md heading names this plan/bug routing; independent of the waiting retire, held-only and Subtract entries, none of which edits `runBacklogCommand`; touches src/cli.ts test/backlog-write-list.test.ts)

**Goal.** A pattern that spells a detail flag is text, not the flag: `tumwater plan --list --grep --show` and `tumwater bug --list --grep --show` list the entries whose heading or body contains the literal `--show` (or print the existing no-match prose) instead of failing in the `--show` branch. A real `--show` keeps routing to the detail view, and a `--grep` beside it is still refused by name.

**Approach.** In `runBacklogCommand` (src/cli.ts), mirror the guard the sibling commands use: find the index of the `--grep` value token once (`const grepAt = args.indexOf("--grep"); const grepValueIndex = grepAt >= 0 ? grepAt + 1 : -1;`), define `modeNamed(flag)` as an arg match at any index other than `grepValueIndex`, and replace the dispatch's `args.includes("--show")`/`--list`/`--edit`/`--cancel`/`--retire`/`--top`/`--release` checks with `modeNamed(...)`. Do this in the one shared dispatch, so plan and bug cannot drift. No help or docs text changes: the documented `--grep` contract already says the pattern is text.

**Files touched.** src/cli.ts test/backlog-write-list.test.ts

**Acceptance criteria.**
- With a PLANS.md entry whose text contains `--show`, `tumwater plan --list --grep --show` exits 0 and lists that entry under its unfiltered number; with no matching entry it prints `no planned features match "--show"`. The same holds for `tumwater bug --list --grep --show` over BUGS.md.
- `tumwater plan --show 2 --grep x` and `tumwater bug --show 2 --grep x` still enter the detail view and refuse the grep beside it by name, as today.
- `tumwater plan|bug --list --grep --cancel`, `--edit`, `--retire`, `--top` and `--release` keep filtering the list for those literal texts; a real `--cancel 2` still reaches the cancel branch.
- The flag-shaped pattern composes with the list's other flags: `plan --list --grep --show --json` prints the filtered JSON document rather than entering the detail view, and `plan --show 2` alone is unchanged.
- `npm run test:gate` passes.

**Tests.** Add a case to test/backlog-write-list.test.ts beside the existing `plan|bug --list --grep searches the active entries` case: seed a plan and a bug whose body contains the literal `--show`, assert `plan --list --grep --show` and `bug --list --grep --show` list them and a no-match fixture prints the no-match prose, assert `plan --show 2 --grep x` still fails naming `--grep`, and assert a real `--cancel 2`/`--show 2` arm still runs. Run test/backlog-write-list.test.ts and test/backlog.test.ts, then the project's gate.

### `tumwater prompt --list --grep` treats a flag-shaped pattern as text, so `--grep --show`/`--grep --json`/`--grep --follow` filter the queue like every other `--grep` (planned 2026-11-08 by the plan role; `parsePromptGrep` in src/cli/cli-command-args.ts refuses any value that starts with `--` with `--grep needs text`, and `scanPromptFlags` collects the mode and rival flags from the raw args before that value token is removed, so the pattern impersonates the flag it spells — `node dist/src/cli.js prompt --list --grep --show` reports `--list and --show are mutually exclusive` and `prompt --list --grep --json` reports `--grep needs text`, where `logs`, `history`, `help`, `reviews`, `quarantine`, `salvage` and the waiting `plan|bug --list` fix all treat the token after `--grep` as pattern text; the waiting `plan|bug --list --grep` plan fixes `runBacklogCommand` in src/cli.ts only and names neither file this plan touches; the landed 2026-10-20 `tumwater prompt --list --grep` entry introduced that `--`-leading refusal (`grep -c 'missing, empty or .--.-leading value' PLANS-DONE.md` prints 1), and no later archived heading changes it; independent in file of every other `## Planned` entry — the Subtract parts touch src/merge, src/runner, src/status, src/doctor, src/gui, src/ui, src/stage, src/events and docs, never src/cli/cli-command-args.ts, src/inbox/prompt-commands.ts or test/cli-prompt-*.test.ts; docs/invariants.md names neither `parsePromptArgs` nor src/cli/cli-command-args.ts (`grep -n 'parsePromptArgs\|cli-command-args' docs/invariants.md` prints nothing), so no invariant edit is needed; touches src/cli/cli-command-args.ts src/inbox/prompt-commands.ts docs/cli.md test/cli-prompt-queue.test.ts test/cli-prompt-follow.test.ts)

**Goal.** A pattern that spells a flag is text to `tumwater prompt --list --grep`, not the flag: `prompt --list --grep --show`, `--grep --json`, `--grep --follow`, `--grep --role`, `--grep --cancel`, `--grep --edit`, `--grep --top`, `--grep --attach`, `--grep --file` and `--grep --at` filter the queued prompts for those literal texts (or print the existing no-match prose) instead of entering a mode, refusing a rival flag or failing the missing-value check. A real `--show <n>`, `--json`, `--follow` or `--role <id>` beside a real `--grep` keeps working, and a valueless `--grep` still fails.

**Approach.** Peel `--grep` before the prompt flag scan, matching how `parseGrepFlag` already lets every sibling filter read its value token as text. In `parsePromptFlags` (src/cli/cli-command-args.ts), call `parseGrepFlag(args, PROMPT_GREP_VALUE_ERROR)` first and run the mode/rival scan over args with both the `--grep` flag token and its value token removed; compute the flag-and-value pair claim from the original `args.indexOf("--grep")` so stray-argument accounting still excuses both. Then make `parsePromptGrep` accept the pre-parsed pattern and refuse only a missing or empty one, deleting its `startsWith("--")` clause. The real `--list` found in the sanitized scan still gates `--grep only applies to --list`; the free-form enqueue mode is unchanged because `--grep` without `--list` is still refused. Keep `parsePromptFollow`'s existing value-slot exclusion for `-f`, now redundant for `--grep` but still needed for the other valued flags. Add one sentence to the `prompt` row in docs/cli.md saying a flag-shaped `--grep` pattern is text.

**Files touched.** src/cli/cli-command-args.ts src/inbox/prompt-commands.ts docs/cli.md test/cli-prompt-queue.test.ts test/cli-prompt-follow.test.ts

**Acceptance criteria.**
- With a queued prompt whose body contains the literal `--show`, `tumwater prompt --list --grep --show` exits 0 and prints that prompt under its unfiltered position; with no matching prompt it prints `no queued prompt matches "--show"`. The same holds for each flag-shaped pattern `--json`, `--follow`, `--role`, `--cancel`, `--edit`, `--top`, `--attach`, `--file` and `--at`.
- `tumwater prompt --list --grep --json` prints the filtered `{ prompts: [...] }` document rather than failing `--grep needs text`, and `tumwater prompt --list --grep --follow` prints one snapshot and exits rather than following.
- Real flags still compose: `tumwater prompt --list --grep deploy --json` filters and serializes, `tumwater prompt --list --json --grep --show` filters for the text, `tumwater prompt --show 2` still prints the second queued prompt, and `tumwater prompt --list --grep -f` still treats `-f` as the literal pattern.
- `tumwater prompt --list --grep` and `tumwater prompt --list --grep ""` still exit 1 with `--grep needs text (usage: tumwater prompt --list --grep <text>)`, and `tumwater prompt --grep x` still exits 1 with `--grep only applies to --list`.
- `npm run test:gate` passes.

**Tests.** In test/cli-prompt-queue.test.ts, extend the existing `prompt --list --grep` cases: seed prompts whose text contains `--show`, `--json` and `--cancel`, assert each flag-shaped pattern lists the matching prompt under its unfiltered position, and assert the no-match fixture prints `no queued prompt matches "--show"`. Keep the existing missing-value, repeat and non-list-mode assertions. In test/cli-prompt-follow.test.ts, add `prompt --list --grep --follow` as a one-snapshot literal-pattern case beside the existing `-f` case, and assert a real `--follow --grep --follow` follows the second pattern. Run test/cli-prompt-queue.test.ts, test/cli-prompt-follow.test.ts and test/cli-command-args.test.ts, then the project's gate.

## Done
