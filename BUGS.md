# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### A work-role runner re-queues the prompt its skipping run declined, and that queue is read as fresh demand, so a `relief_wait` recovery spins at the poll cadence (mirrors GitHub issue #2; found by the director role 2026-11-23)

**Symptom.** A role whose worktree branch holds a relief commit beside the merge pin it queued — the
reporter's `ci`, which ran 18,257 times in ~2 h, each run `durationMs≈1000`, `result=skipped`, no
model call ever made — repeats every scheduler poll (~2 s) although its state carries a correct
future `nextRunAt`. The same shape appeared on `feature` and `feature-3`. The reporter's two prompts
(`Main was reported red at commit …`, plus a user message) stayed in that role's inbox the whole
incident, never fulfilled. Event shape: `run_start` → `prompt_taken` → `run_end result=skipped` →
`wake reason=inbox` → `run_start`, without end.

**Reproduce.** Seed a pooled worktree whose branch is ahead of main, `state.queuedSummary` set to a
merge entry for that branch's pin, and a second commit on the branch ahead of the pin — that is
`recoverLeftover`'s `heldBesidePin` true, so it returns `{kind:"relief_wait", entry}`
(src/runner/runner-leftover.ts). Give the role one deliverable inbox prompt. Run the eligibility
pass (`skipRunner` → `isEligible` in src/scheduling/) and then the run's end: the run starts,
ends `skipped`, its prompt is back in the queue, and the next poll admits it again. `nextRunAt` is
never consulted, and the poll logs the `{type:"wake", reason:"inbox"}` line the reporter saw
(src/orchestrator/orchestrator-launch.ts logs a wake for every admit reason but `scheduled` and `startup`).

**Suspected cause.** Three verified facts, and the two defences that already stop this for the
director are keyed to the director alone:

- The skip re-queues the prompt it declined: `handleRecoveredLeftover`
  (src/runner/runner-leftover-recovery.ts) routes every recovery kind except `already_queued` to
  `ctx.finishRecoveryRun` → `finishRecoveryRunPhase` (src/runner/runner-recovery.ts), which ends the
  run `skipped` and then calls `ctx.pending.requeueUnfulfilled(userPrompt)`
  (`PendingPrompt.enqueueCarryingImages` in src/inbox/pending-prompt.ts) regardless of the recovery
  kind — so the re-queued file's name stamp is stamped inside the run that just ended.
- The queue is then read as fresh demand: `skipRunner` counts it with `inboxSize(root, runner.role)`
  (src/scheduling/skip.ts) and `inboxGate(inboxCount)` (src/scheduling/scheduling.ts) admits
  `inboxCount > 0` with `reason:"inbox"` ahead of `gapGate`/`scheduledGate`, so a correctly computed
  `nextRunAt` (main's head unchanged → the role's slow clock) is simply never consulted.
- The defences are director-scoped: `skipRunner` computes `EligibilityOptions.inboxSelfRequeued`
  (every deliverable stamp from `inbox.deliverablePromptStamps` at or before
  `state.lastRunEndedAt`) only when `baseRoleOf(runner.role) === "director"`, and `ownPinDraining`
  only for `runner.role === DIRECTOR_ROLE` against `directorDrainingPin`, which
  `directorPinOwedRun` (src/scheduling/scope.ts) derives from `mergePinSha(root, DIRECTOR_ROLE)`.
  `directorGate` honours both — it holds the inbox on `ownPinDraining` and routes a self-requeued
  inbox through `dueOnMinInterval`, citing that hot loop — while the work-role arm `inboxGate`
  consults neither.

**Fix (one run), in the scheduling layer only.**

1. `skipRunner` (src/scheduling/skip.ts): drop the `baseRoleOf(runner.role) === "director"` guard
   from the `inboxSelfRequeued` computation so it is evaluated for every role (it already requires
   `inboxCount > 0` and a set `lastRunEndedAt`, so an empty or undeliverable inbox stays false).
2. `inboxGate` (src/scheduling/scheduling.ts): take the state, `now` and `opts` as `directorGate`
   does, and resolve a `inboxSelfRequeued` inbox through `dueOnMinInterval(s, now, "inbox")`
   instead of admitting immediately — the same rule `directorGate` already applies to itself. A
   prompt an operator submitted after the run ended still runs immediately.
3. Extend the drain hold to work roles: compute the runner's own draining pin with
   `mergePinSha(root, runner.role)` (src/merge/merge-pins.ts already takes a role) in
   `buildSchedulingScope` and set `ownPinDraining` when it equals `state.queuedSummary?.sha`, so a
   role waiting on the merge slot for its own change holds its inbox instead of churning on it.
   Queued prompts are not dropped by the hold: they run as soon as the pin lands or the claim is
   released (`buildSchedulingScope` releases stale claims each pass).

**Acceptance.** New tests in `test/scheduling.test.ts` (which already pins `isEligible`): a
non-director runner whose inbox holds only a prompt stamped at or before its `lastRunEndedAt` and
whose `nextRunAt` is in the future is not admitted; the same runner is admitted once `nextRunAt`
has passed; a prompt stamped after `lastRunEndedAt` is admitted immediately; a non-director runner
whose own `mergePinSha` equals its `queuedSummary.sha` is held while that pin is queued and
admitted again when the pin is gone. One end-to-end regression in `test/orchestrator*.test.ts`
style with the relief fixture: two consecutive polls for a `ci` runner in the `relief_wait` state
start at most one run — reuse the `relief_wait` fixture shape already in
`test/runner-recovery.test.ts` and `test/runner-leftover.test.ts`.

**Sibling.** The report's other ask — that repeated `skipped` outcomes escalate their interval
instead of returning to the fixed minimum — is a separate defect in a different file (`run/run-apply.ts`),
recorded below. Neither depends on the other; land either first.

### A plan run re-adds a merged, already-archived plan under PLANS.md `## Planned`, and no guard compares `## Planned` against PLANS-DONE.md, so finished work is handed back out as open work (found by the selfcheck role 2026-11-23)

**Symptom.** Twice on 2026-11-22 a `tumwater(plan):` commit added a copy of a plan that main had
already built and archived, under `## Planned`, with no `done` stamp — so the backlog index kept
listing finished work as eligible, a feature run picked it up and had to spend a whole run proving
it was done, and a cleanup run spent more. Neither the staging check nor the gate objected.

Instance 1, the `waitingPush` banner plan. `c13887f2b` (plan, 14:31) added
`### An issue GitHub closed upstream stops holding the \`waitingPush\` banner, so the blue "push
main and it closes" alert can no longer stand forever…` to `## Planned`. `1ed332cfb` (feature,
16:10) built it and the sweep archived it: in that commit `PLANS.md` carries `waitingPush` 0 times
and `PLANS-DONE.md` carries the heading once. Nine minutes later `89c4fb469` (plan #2734, 16:19)
appended the same entry back under `## Planned` — `git show c13887f2b:PLANS.md` and
`git show 89c4fb469:PLANS.md`, each grepped for `^### An issue GitHub closed upstream`, produce
identical heading lines, unstamped. `4df32ec6` (feature-2 #967, 18:00) is the hand-back: "Hand back
the waitingPush-banner plan as a plan defect: already merged" (39 turns). `68e93f58` (plan #2736,
19:40) removed the copy (105 turns / 83 min, high friction).

Instance 2, the report-tally plan, planned *by that same commit*: `89c4fb469` added
`### \`tumwater report\` tallies the GitHub-issues mirror by outcome…`; `a5e1a9c24` (feature,
17:04) built it and archived it (`PLANS.md` copy count 0 in that commit, `PLANS-DONE.md` count 1);
`ec883c64` (plan #2735, 17:46) added it back under `## Planned` while that commit's own
`PLANS-DONE.md` already held it (count 1 at `ec883c64`, count 1 at main's tip — the archive was
not polluted, only the live section). `db03d8ab` (feature #3062, 20:59) handed it back as a plan
defect (64 turns); `d7c22114` (steward #26, 21:19) deleted both stranded copies — "Delete two
PLANS.md planned entries already merged and archived" (53 turns / 43 min, high friction). The four
runs that only cleaned up or refused the copies are the loss; the same day's
`tumwater(plan)` commits also show the churn compounding (plan #2734 66 turns / 40 min,
plan #2735 144 turns / 86 min, plan #2736 105 turns / 83 min, plan #2737 152 turns / 146 min).

This is the plan-side twin of the open entry at the top of this section ("The selfcheck filing path
dedupes against `## Open` and selfcheck's own commits only…", found by the bugfix role
2026-11-22): there, a fixed bug was re-filed as open work; here, a built plan is re-planned as open
work. One seam can settle both — see Fix direction.

**Reproduce.** Offline, no model and no gate. On any tree where `PLANS-DONE.md` already holds a
`### ` heading with its `— done` stamp, append an unstamped copy of that heading under PLANS.md
`## Planned`: nothing objects. `npm run test`'s backlog guards
(`test/backlog-structure.test.ts`, `test/stage-backlog-checks` coverage of
`duplicatePlanFinding`, `test/backlog-index-edges.test.ts`) stay green, the staging check raises no
finding, and the backlog index prints the copy as an actionable planned entry. The two commits
above are the live instance: `git show 89c4fb469 -- PLANS.md` adds 172 lines to `## Planned`
including the archived heading, and `git log --since=2026-11-22T16:00 --until=2026-11-22T17:00`
shows `1ed332cfb` archiving it 9 minutes earlier.

**Cause.** No guard reads the archive on the live side. All four relevant checks are section- or
file-bounded:

- `duplicatePlanFinding` (src/stage/stage-backlog-checks.ts:82) builds its known set from
  `parseEntryDetails(current, "Planned")` and the pending unmerged changes (:103-104) and skips
  entries the base `## Planned` already had (:105-106), so only other *planned* entries — never
  PLANS-DONE.md — make a copy known.
- `duplicatePlannedEntries` (src/backlog/backlog-structure.ts:448) and its projection
  `renderDuplicatePlansBlock` (:505) read `sectionBodyLines(md, "Planned")` (:449), so they catch
  two copies inside `## Planned` and nothing else.
- `readdedHeadings` (src/backlog/backlog-structure.ts:179) is the one guard that compares a
  heading multiset against an archive, but its caller `readdedHeadingReason` (:274) enters it only
  `if (file === PLANS_ARCHIVE || file === BUGS_ARCHIVE)` — a change editing the archive itself.
  A change to PLANS.md never reaches it.
- `finishedDuplicateFindings` (src/stage/stage-backlog-checks.ts:124) needs a live entry under
  `spec.section` (`Done` / `Fixed`) whose `finishedKey` matches an archive copy; an unstamped copy
  under `## Planned` is not parsed by it at all.
- The `<pending-plans>` block the plan charter is told to consult
  (`pendingPlanChanges`, src/backlog/backlog-pending.ts:128-130) diffs PLANS.md `## Planned` only,
  so it cannot surface an archived either.

The charter already asks for the check the machine does not make — plan step 3
(src/roles/role-catalog.ts:219-222) says "confirm with grep that… no finished plan in
PLANS-DONE.md already covers it" — and it failed twice in one eight-hour window, so a prompt-only
fix is not what this entry asks for.

**Fix direction (the bugfix role picks one seam, not all).** Cheapest: extend
`duplicatePlanFinding`'s known set with the archive headings already on main —
`parseEntryDetails(archiveHead, "Done")` read once per change, keyed by `finishedKey` /
`entryKey` the way that function already keys plans — and return the same staging-finding shape
("this change re-plans the finished plan \"…\", archived in PLANS-DONE.md — drop the copy") rather
than a merge-gate refusal, since a duplicate is repairable, which is how that function's existing
finding is worded. Stronger: also add a `## Planned`-vs-archive arm to
`duplicatePlannedEntries`' callers so the doctor row and the backlog index stop offering the copy
as eligible work before any commit exists. Either way, mirror the same seam for BUGS.md `## Open`
against BUGS-FIXED.md so the bug-side twin at the head of this section closes with the same rule.
Tests belong in `test/backlog-structure.test.ts` (a `## Planned` heading whose key matches a
done-stamped PLANS-DONE.md heading is reported; an unrelated planned heading is not) and in the
staging-check coverage that pins `duplicatePlanFinding`'s finding text today. A fixture archive
under a scratch dir, never this repo's real PLANS-DONE.md.

**Notes for the fixer.** Do not key on exact title text: instance 1's copy was byte-identical,
but the bug-side twin was reworded under an identical heading, and
`finishedDuplicateFindings`' exact-copy skip (stage-backlog-checks.ts:149-152) shows what happens
when a guard demands text equality — the copy survives. Key on `entryKey`
(src/backlog/backlog-parts.ts:61) or `finishedKey` with the stamp stripped, as the existing plan
duplicate guard does. Expect `PLANS-DONE.md` to hold ~13k headings: read it once per check and
cache it the way `duplicatePlannedEntriesFor` caches PLANS.md (backlog-structure.ts:478-492),
not per entry.

### A held relief commit beside a role's own undrainable pin ends every run before authoring, so a red main freezes the fleet and the healer can neither merge its fix nor author another (mirrors GitHub issue #3; found by the director role 2026-11-23)

While main was red on a ledger guard test, a 26-role fleet deadlocked: 16 roles held merge pins, every role's `lastResult` was `skipped`, and nothing progressed across two orchestrator restarts — the state is all in the repo (pins, branch tips, red main), not in process state, so restarting does not clear it. The role whose charter is red-main repair (`ci`) was structurally unable to act on either half of its job. Its fix commit sat pinned waiting for the merge slot, but the gate keeps a failing pin while the tree it merges is red ("a red main's included", `reviewPinnedChange`'s doc comment in src/merge/merge-core.ts), so the pin never drains. Its *next* fix commit sat on the same branch beside that pin (`pinAndEnqueueChange`'s `heldOnBranch` path, src/run/run-stage.ts: pin nothing, commit stays on the branch, run ends `queued` with `heldOnBranch`), and every subsequent `ci` run took `recoverLeftover` → `relief_wait` → `finishRecoveryRunPhase`, which ends the run **before any authoring** (`src/runner/runner-recovery.ts`: "end skipped, no authoring run"). The held commit — exactly the repair main needs — is what blocks the run that would make it mergeable.

**Reproduce.** In a fake-pi harness fixture: a role whose gate run fails, so `reviewPinnedChange` (src/merge/merge-core.ts) keeps its pin under the strike cap (an under-cap failure keeps the ref for re-merge, and the tree the drain merges is red) and the gate never green-lights it — main itself failing is the permanent version (the sibling entry above, mirroring GitHub issue #5, is one way "the check main fails" stays red). The run's own commit is pinned; the next run, admitted by the interlock-relief rule, commits a second commit on the same branch and takes `pinAndEnqueueChange`'s `heldOnBranch` path, so nothing new is pinned. `recoverLeftover` (src/runner/runner-leftover.ts) then finds a live pin whose sha equals `ctx.queuedSummary.sha`, under `MERGE_CONFLICT_LIMIT`, and `heldBesidePin` (same file) returns true — `aheadOfMain` > 0 and `headOf(wt,"HEAD") !== pinSha` — so the live-pin arm returns `{kind:"relief_wait", entry}` and nothing else ever settles the pin: `applyChangeLifetime` (src/run/run-apply.ts) bumps `mergeConflicts` **only** on `merge_conflict`, and the pin-classifying path (`directorPinOwedRun` in src/scheduling/scope.ts, `pinnedRetrySha` in src/runner/runner-leftover.ts) exists only for the director. `handleRecoveredLeftover` (src/runner/runner-leftover-recovery.ts) keeps the branch, `finishRecoveryRunPhase` returns `{result:"skipped", recoveredLeftover:true}`, no authoring prompt is ever sent, and the loop repeats at the poll cadence. `test/runner-leftover.test.ts` ("a commit held on the branch beside the role's own pin waits (relief_wait), never reset away") and `test/runner-recovery.test.ts` ("finishRecoveryRunPhase ends a relief_wait skipped and leaves the held commit on the branch") pin that behavior exactly as written, so the deadlock is designed-in, not an accident of one fixture.

**Suspected cause.** `relief_wait`'s one job is to protect unmerged work — INV-DA1's guarantee (docs/invariants.md, "Director leftover: a kept pin owes an authoring run only while no queue entry will settle it") states the held commit "stays on the branch" and is never stranded — and it does that by holding the branch and ending the run. It asks only whether the role has a live pin and a held tail (`heldBesidePin`); it never asks whether that pin can still drain, nor whether the held tail *contains* the pinned commit. Two consequences: an undrainable pin (a gate that cannot go green while main is red) turns the hold into a permanent no-authoring spin, and the held tail is never folded into the pin it is standing next to, even when the branch tip is the pinned commit plus the new fix — the cheapest possible un-jam, since merging the tip merges both.

**What a fix must settle (pick one shape, do not stack three).** The cheapest is containment-aware recovery: in `recoverLeftover`'s live-pin arm, when the branch tip already contains the pinned sha (`isMergedInto(worktree, pinnedSha, "HEAD")` in src/git/git.ts) and the pin has no live in-flight merge marker record (`readMergeMarker` → `mergeChanges`, src/merge/merge-slot.ts — a change already mid-merge must never be re-pointed), re-point the role's `mergeRefName(role)` ref to the branch tip (`setRef`, src/git/git.ts) and return `{kind:"pinned"}` with an entry whose sha and summary name the TIP (`recoveredMergeEntry`, same file), so the existing pinned arm ends the run `queued`, the drain gates and merges one combined commit, and the once-only `merge_queued` guard (`ctx.queuedSummary?.sha !== sha`) correctly logs a fresh event for the new sha. `finishRecoveryRunPhase`'s reset condition (`headOf(wt,"HEAD") === entry.sha`) then holds, so the worktree resets to main with both commits safe on the ref. The held tail is then not held at all: it is the pin. That settles the healer's second fix (it reaches the gate) without any new pin-dropping rule; authoring stays blocked on an undrainable pin, which is the acceptable half — a role must not write another change while one of its own is still in flight. Only if that turns out not to un-jam the reported case should a fix consider settling an undrainable pin, and then never by discarding it — `grep -n 'deleteRef(.*mergeRefName' src` names every site that drops a pin today (merge-core.ts's rejection and strike-cap discard, merge-pipeline.ts, merge-withdrawn.ts, runner-apply.ts, operator-retire.ts), and each leaves the commit recoverable, by a rejected ref or by the branch.

**Notes for the fixer.** `recoverLeftover` must not reset the worktree or the branch in the new arm — that is INV-DA1's territory; re-pointing a ref adds a commit, destroys none. `docs/invariants.md`'s INV-DA1 sentence needs the qualifier in the same commit ("a held tail that contains the pinned commit rejoins the pin; a held tail that does not is still held and the run ends skipped"), and INV-DA2 is unchanged. Keep the two existing relief_wait tests green by adding a fixture where the held tail does NOT contain the pin (a re-ordered or rebased branch) and asserting it still takes today's `relief_wait` path. Do not touch the `mergeConflicts` counter for this bug: `relief_wait` is not a conflict, and inflating it would make the conflict cap silently discard the healer's work. `test/runner-leftover.test.ts` ("a commit held on the branch beside the role's own pin waits (relief_wait), never reset away", "a queued merge with a relief commit ahead of main recovers relief_wait, not already_queued") and `test/runner-recovery.test.ts` ("finishRecoveryRunPhase ends a relief_wait skipped and leaves the held commit on the branch") are the surface, plus the drain tests in `test/merge-drain.test.ts`; no scheduler change should be needed (`ownPinDraining` in src/scheduling/skip.ts already re-runs the role as soon as its own pin leaves the queue). Not the same bug as the `relief_wait` entry above (a runner re-queues the prompt its skipping run declined, and that queue reads as fresh demand): that one is the prompt ride and the cadence spin inside a skipping run, this one is why the run can never author at all and why the held tail and the pin are never joined. Neither fix settles the other.

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
- 2026-11-22 run (real): fresh `npm run build` of worktree tip 30cb5dd1 + `init "Build a tiny markdown-to-html converter CLI in Python."` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` + `config set maxConcurrent 1` + `config unset bootstrap` + `start --once --role feature --json` (with `TUMWATER_SUPERVISOR_PID`/`TUMWATER_SUPERVISED`/`TUMWATER_RUN` stripped from the environment) — one real run on OpenCode's free DeepSeek tier: `{"runs":1,"outcomes":{"no_change":1},"skipped":[],"failures":[]}`, exit 0, 29s, 871 output tok (prompt 46.5k tok, 67% cached), $0.00; `status` printed the 20-row role table with the documented `Declaring a build check` info alert and `budget: n/a` for an all-free team, `doctor --problems` printed `ready to run` with `70 ok checks hidden`, and `history`, `history feature --last` and `report` matched docs/cli.md; no tumwater or opencode process outlived the round and the scratch dir was deleted.
- 2026-11-17 run (real): fresh build of worktree tip 1fc125aa + `init` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` (the free no-login OpenCode tier) + `start --once --role feature --json` — exactly one real run on opencode's free DeepSeek, a `no_change` round (943 tok, $0.00, ~51s), exit 0, clean `orchestrator_start`/`stop` with no leaked process; `status` feature row (1 run, $0.00, `no change`) + the documented `No build check declared` alert + the 16-row role table all match README/docs, and `logs` confirms `run #1 started on opencode/deepseek-v4.1-flash-free` → `no change · 943 tok`.
