# No duplicate plans: plan against the backlog as it will be, and retire a copy without asking

Planned 2026-11-04 · requested by the user, after an operator session cancelled 12 refused plans
on a tumwater project by hand:

> "analyze whether we might have an opportunity in tumwater to self-heal and automatically cancel
> any plans that the user was just going to have to cancel anyway once they are surfaced to the
> user."

Asked to file the result as a plan, they said "File the plan".

## What happened

- **The incident (2026-11-03/04, a project running 0.4.6).** The dashboard showed "12 refused
  entries wait on your decision". All 12 were `## Planned` entries with nothing to build: 9
  duplicated work that had already merged or was already queued, 2 would have undone landed
  work, and 1 named a test cell that does not exist. The operator cancelled all 12 with
  `tumwater plan --cancel`. In its clearest pair, plan run 700 started one second before run
  699's plan merged and planned the same GTK toolbar change again. Feature implemented one copy
  and refused the other.
- **Since the 2026-10-28 hand-back, a refusal means "close it".** Between 10-01 and 10-28,
  tumwater's own repo had 19 refused entries. Only 4 were closed without being built: 2 by
  operator cancels, 2 removed by roles. The other 15 went ahead after a release or a replan.
  They were plan defects, missing prerequisites, or the review-cap misroute. Since 10-28 all
  three kinds reach the plan role as `Needs review` notes, and tumwater has had no `Refused`
  note since. The one later sample is the incident's 12, and the user cancelled all of them.

## Today (measured 2026-11-04 on tumwater's own repo)

- **Most plan runs cannot see the previous plan.** From 10-30 20:30 to 11-04 01:04, 47 of 64
  plan runs that queued a plan started while an earlier plan change was still unmerged.
  - While `## Planned` is below its target, the plan role runs with a zero gap
    (`scheduleConfigForRole`).
  - Interlock relief (plans/interlock-relief.md) lets a role run again while its change waits.
    A run that finishes meanwhile holds its commit on the branch, and leftover recovery queues
    it at the next run's start. The run after that starts about 2 s later.
  - Every new run's worktree starts at main, and its `<backlog-index>` is read from the primary
    checkout. A plan on a merge pin or held on a branch is invisible to it.
  - The plan role's pick follows a ranking that the pending plan does not change, such as the
    worst complexity score or the worst fidelity cell. So the blind run often picks the same
    item again.
- **In tumwater, duplicates get built twice instead of refused.** Since 10-30, 8 functions got
  two or more same-day refactor plans:
  - `assemblePayload` (4 Done entries; two feature runs split it a minute apart) and
    `historyPaneCache` (3).
  - `runAgent` (split into 4 helpers, then re-split into 5 three hours later).
  - `collectRoleRows`, `mergeSectionEntries`, `skipRunner`, `cmdRole` and `loadRunnerState`.
  - This counts only refactor plans whose titles share the `` `fn`'s … `` shape, so it is a floor.
- **The race also splits a parked entry twice.** On 11-04 `## Planned` holds two copies each of
  "Every commit is verified on main" parts 4k/3, 4m/3 and 4n/3, and of "Subtract verify
  collapse" parts 2/5–5/5. Each pair comes from two plan runs splitting the same too-large
  entry: the second run started while the first split was unmerged, so main still showed the
  `Needs review` note. Two feature runners had claimed both copies of 4m/3 at once.
- **There is no way to close a plan without building it.**
  - On 10-31 the steward moved a duplicate `assemblePayload` plan to `## Done` without a done
    date. The clean role's stranded-entry rule (`strandedPlanEntries`) moved it back to
    `## Planned`, feature built it again, and the steward retired it again.
  - The clean role now adds a `done` date instead of moving such an entry back. The archive
    then claims work that never happened.
  - The incident's archive had the same problem: a closed-as-unpinnable entry stamped `done`,
    and the same plan stamped `done` twice.

## Decision

1. **Plan against the backlog as it will be.** The plan role's stop count and its
   `Needs review` check read `## Planned` with every unmerged change applied: the merge pins
   (`refs/tumwater/merge/<role>`) and role branches held ahead of main. Its prompt lists what
   those changes add and remove. This removes the cause, and it also covers the double split.
   - Pins and branches outlive the merge queue (Subtract parts 3e/7 and 3f/7), so nothing here
     reads the queue.
   - We do not hold the plan role until its last plan merges. That would bring back the wait
     interlock relief removed: plan merges took 5–43 min on 10-30.
2. **A plan can be retired.** An entry closed without being built moves to `## Done` with a
   `— retired YYYY-MM-DD` heading stamp and a `**Retired YYYY-MM-DD by <role>: <evidence>**`
   body line. The evidence names the landed commit (a short SHA on main) or the surviving entry
   (its quoted heading), or says plainly why nothing is buildable.
   - `done` keeps meaning built. Every reader that tells finished from open accepts `retired`.
     A `requires … landed` clause naming a retired part counts as dangling, so the retiring
     change must point dependents at the survivor.
3. **The plan role retires duplicates itself.**
   - Two `## Planned` entries with the same heading key, or the same series part label, are
     duplicates found by reading the markdown alone. The plan role is shown them and retires
     the extra copy before planning anything new.
   - Staging rejects, for one fix-up turn, a change that adds a `## Planned` entry whose key or
     part label is already planned on main or in an unmerged change.
   - None of this is a merge-gate rejection. Since part 3m/3 the gate refuses only what a later
     commit cannot repair, and a duplicate can be repaired.
4. **Feature hands "nothing to build" to the plan role.** A plan whose deliverable already exists
   on main, that another entry already carries, or that a measurement disproves gets the
   existing plan-defect note, naming the evidence. The plan role checks the evidence and retires
   the entry. Staging checks that a cited SHA is on main and that a quoted survivor exists.
5. **`Refused` stays the user's call,** for a product or design decision only. The refused-entries
   alert and `plan|bug --release` keep their behavior. We build no harness tool that cancels
   refused entries by parsing the refusal's wording: refusal prose has no fixed format, and once
   parts 1–6 land the refused set should hold only real decisions.

## What lands

| Part | What | Requires |
|---|---|---|
| 1/6 | The `retired` stamp: structure rule, done/requires readers, the clean role's wording, docs | — |
| 2/6 | Pending-change snapshot; `planBacklogFull` and the stop note count the projected backlog | — |
| 3/6 | The plan role's `<pending-plans>` prompt block and charter wording | 2/6 |
| 4/6 | Duplicate `## Planned` entries found by reading the markdown; the plan role's `<duplicate-plans>` block and retire task | 1/6 |
| 5/6 | Staging finding: a change adds a duplicate, or retires with evidence that does not check out | 2/6, 4/6 |
| 6/6 | Feature's "nothing to build" hand-back; plan role may retire; `Refused` narrowed to user calls | 1/6 |

Parts 1/6 and 2/6 are independent and can go first in parallel. Part 6/6 must merge only once
part 1/6 is the running build (PLAN_SIZING's self-build rule). Under an older build, the clean
role would read a retired entry as a stranded one and stamp it `done`. The redeploy follows the
next green full check, so the gap is at most about an hour.

## Not in this plan

- Operator `plan --cancel` keeps deleting the entry. Recording a `Retired … by the user` record
  there instead is a possible follow-up; this plan does not decide it.
- A bulk "cancel all N refused" action on the alert. It is not needed while the refused set
  holds only real decisions. If it becomes needed, file it separately.
- BUGS.md. The incident had no refused bugs, and bug closure already has its own `## Fixed`
  wording.
- Duplicate plans whose wording drifted and that share neither a key nor a part label (four of
  the incident's 12). Parts 2–3 stop them from being written. One that still lands reaches the
  plan role through feature's hand-back (part 6), not through a detector.

## Risks

- **A wrong retire hides real work.** Part 5 checks the evidence a retire cites, the retired
  entry stays in the archive with its body, and the post-merge review reads every retire.
  Deterministic detection (part 4) uses exact keys and part labels only.
- **Snapshot cost.** Part 2 adds one `git for-each-ref` per poll. It diffs only refs not merged
  into main and caches each result by SHA, since SHAs never change. On macOS, starting
  processes is the bottleneck, so it must not spawn per role per poll.
- **The projection and the merge disagree.** If an unmerged change cannot be applied entry by
  entry (`mergeBacklogEntries` returns null), the snapshot falls back to adding that change's
  new headings and removing the headings it deletes. A stale projection lasts at most one poll.

## How we will know it worked

- `## Planned` heading keys and series part labels stay unique on main, and the
  `<duplicate-plans>` block is absent from most plan runs' prompts.
- Same-day duplicate Done entries for one function (the `` `fn`'s … `` count above) drop to 0.
- No plan run starts while an unmerged plan change is missing from its prompt (measured from
  events.jsonl as above, with the snapshot's own event or the prompt as the check).
- Refused plans that the user then cancels stop appearing on projects running the release that
  carries parts 1–6.
