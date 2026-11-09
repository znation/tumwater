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

### Subtract, part 3f/7: The durable merge queue and its status/doctor readers go (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract part 3i/7 and Subtract part 3j/7 landed; touches src/merge/merge-queue.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-slot.ts src/merge/merge-requeue.ts src/status/status-data.ts src/status/status-roles.ts src/status/status-polls.ts src/doctor/doctor-backlog.ts src/doctor/doctor-check-names.ts src/doctor/doctor-holds.ts src/gates/gate-polls.ts src/scheduling/once-round.ts src/events/event-notify.ts docs/how-it-works.md test/merge-queue.test.ts test/merge-requeue.test.ts test/merge-slot.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/doctor-checks.test.ts test/status-data.test.ts test/status-roles.test.ts test/once-round.test.ts)

**Goal.** With part 3e writing no queue file and part 3i stopping the recovery path's queue write, the queue, its pipeline, slot and requeue modules are dead state. Delete them and re-point every reader at the pin/in-flight marker: status shows a role's waiting pin, the doctor drops the two merge-queue rows, and `once --once` waits on no in-flight merge instead of an empty queue directory.

**Approach.**
- Delete src/merge/merge-queue.ts, merge-drain.ts, merge-pipeline.ts, merge-slot.ts and merge-requeue.ts; move the one in-flight marker type/reader the new pin path and post-review drain still need into a small module beside merge-core.ts, move the `PriorReview` type there too so `src/git/commit-message.ts`'s type-only import survives the deletion (update its importers), and delete `.tumwater/merge-queue/` handling (`mergeQueueDir`, `legacyLandQueueDir`, the startup migration step) from src/paths.ts and startup-migration-steps.ts.
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

### `scanEventsFileInner`'s complexity-13 window scan in src/events/event-window.ts is split into named module-private helpers — the backward tail read with its window-start check, the in-window event collection, and the resume end — so "where did the backward scan stop, and does this file reach before the window?", "which parsed lines fall inside the window?" and "where may the next read resume?" are each read from a name instead of one body holding the tail callback, the parse loop and the trailing-fragment arithmetic (planned 2026-11-09 by the plan role; continues the landed split-large-function family — eslint's one-shot (`../../../node_modules/.bin/eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs src/events/event-window.ts`) reports `scanEventsFileInner` at 13 over 62 lines while every other body in the file is at 10 or below (`oldestCompleteLine` at 10, `classifyLogText` at 9), so this is the file's one remaining unsplit concentration; `grep -c 'scanEventsFileInner' PLANS-DONE.md` prints 0 and `grep -n 'scanEventsFileInner' PLANS.md BUGS.md` prints nothing before this entry, and the archive's event-window headings are the rotation, report and tail-read features, never a split of this body; independent in file of every `## Planned` entry — the Subtract parts take src/merge, src/runner, src/status, src/doctor, src/config, src/cli and docs, the failure-data split takes src/failure/failure-data.ts, the `render` split takes src/ui/tui/tui.tsx and the `retireEvidenceFinding` split takes src/stage/stage-backlog-checks.ts, so none touches src/events/event-window.ts; docs/invariants.md INV-B1 binds `readWindowEvents` and the trailing complete-line/torn-fragment tests, and a behavior-preserving private move leaves it unchanged; touches src/events/event-window.ts)

**Goal.** `scanEventsFileInner` (src/events/event-window.ts, complexity 13) does three separable jobs in one body around `readTailTextWithEnd`: it scans backwards and decides whether the file reaches before the window, it splits the read text and collects the parsed events whose day is in the window, and it computes where a later read resumes from the last complete line. A reader asking any one question must trace the whole body. Lift each into a named module-private helper and leave `scanEventsFileInner` as the ordered calls plus the `classifyLogFile` result, with no event, coverage flag, end offset or log state changed.

**Approach.** All edits in src/events/event-window.ts; move the existing code and comments verbatim, change only indentation, and add no import.
- Add `function readWindowBackwards(file: string, fromKey: string): { text: string; coveredEnd: number; coversFullWindow: boolean }` above `scanEventsFileInner`: the existing `readTailTextWithEnd` call and its `oldestCompleteLine`/`parseEventLine`/`eventDayKey` early-stop callback, then the current file-start check (`text.split("\n")[0]` parsed once, `day < fromKey`) when the backward scan did not early-stop. Return the text, `coveredEnd` and the flag.
- Add `function inWindowEvents(text: string, fromKey: string): HarnessEvent[]`: the existing `text.split("\n")` loop that skips empty and unparseable lines and pushes each parsed event whose `eventDayKey` is non-null and `>= fromKey`, in read order.
- Add `function resumeEnd(text: string, coveredEnd: number): number`: the existing trailing-fragment rule — the last split line is a newline-less fragment, and `end` moves past it only when that fragment parses as an event, else stays at `coveredEnd`.
- Leave `scanEventsFileInner` with `const st = statOrNull(file);`, the call to `readWindowBackwards`, then `inWindowEvents`, `resumeEnd`, and the same `{ events, coversFullWindow, end, logState: classifyLogFile(text, st) }` return. Keep its doc comment; each new helper is module-private.

**Files touched.** src/events/event-window.ts

**Acceptance criteria.**
- For the same log bytes and `fromKey`, the returned `ScannedFile` is unchanged: the same `events` in the same order, the same `coversFullWindow` for a file that early-stops before the window, one that reaches the file start but starts before the window, and one that starts inside the window, the same `end` for a complete trailing line and for a torn trailing fragment, and the same `logState`.
- A missing or unreadable log still scans to the empty window through `scanEventsFile`'s fallback, and the cache key and copied return are untouched, so `readWindowEvents` keeps its archive and rotation behavior.
- `grep -nE '^export ' src/events/event-window.ts` prints the same declarations before and after, and each new helper is declared once at module scope and is not exported.
- The complexity one-shot (`../../../node_modules/.bin/eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs src/events/event-window.ts`) reports `scanEventsFileInner` below 10 (13 today) and every new helper at 10 or below.
- `npm run test:gate` passes.

**Tests.** No new test module: the move is behaviour-preserving. test/event-window.test.ts pins the backward early stop, the before-window and fully-covered cases, and INV-B1's trailing complete-JSON line and torn-fragment resume cases; test/event-legacy.test.ts reads the same window path over an old-format line. Run test/event-window.test.ts and test/event-legacy.test.ts, then the project's gate. If an assertion moves, a helper took the wrong branch or reordered the read; restore the original expression rather than editing the test.

## Done
