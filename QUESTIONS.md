# Questions

Open questions loops have posted for a human decision — each with context, the options, and the
loop's recommendation. Answer by moving an entry to ## Answered with your decision (or tell the
director). Loops never block on their own questions; they check here at the start of each tick.

## Open

### Should agent runs keep verifying with the full `test:gate`, or switch to targeted tests and leave the full gate to the team's own check? (asked by the bugfix role 2026-10-28)

**Context.** BUGS.md lines 241-245 ("Decide whether agent runs keep verifying with the full `test:gate`") — split by the plan role from the `maxConcurrentChecks` bypass — is a policy call about the verification guarantee, so a run must not change it unilaterally. The run prompt's verify rule (`src/prompt/prompt.ts`) has every agent run execute `npm run test:gate`, and the team then runs the same gate check on the change (the merge checks, `src/build/build-check.ts`), so each change's suite runs twice and agents add 1.3–1.7 full-width suites in flight against a host already at the load-flaky ceiling (load avg ≈105–190; 965/915 full suite runs a day on 10-23/10-24). This is separate from (though it shares the load pressure with) the steward's open question above, whose recommendation Option 2 proposes gating agents' suites with the `maxConcurrentChecks` permit instead.

**Options.**
1. **Keep `test:gate` on every agent run** (status quo). Strongest per-run verification, but each change's suite runs twice and contributes the most load pressure; the team's own gate then re-runs the same work.
2. **Drop the agent-side `test:gate`, run targeted tests only** (the entry's stated expectation). Each change is still verified by the team's own full-gate check on merge, preserving the "every commit is verified on main" guarantee while roughly halving the duplicative suite load and cutting most of the agents' in-flight contribution.
3. **Keep `test:gate` but gate it behind the `maxConcurrentChecks` permit** (BUGS.md permit entry, steward's Option 2). Preserves per-run verification but queued runs can hang past a run's own bash cap, and it depends on the permit entry landing and on actually lowering host load.

**Recommendation.** Option 2 (drop the agent-side full gate, target instead). The team's own gate check on main already delivers the "every commit is verified on main" guarantee the active plan series builds; the agent-side re-run is the duplicative half and the biggest single contributor to the agent-load that holds the host at the flaky ceiling. If the team wants per-run full verification preserved anyway, Option 3 (permit-gated) is the load-honest form — but it needs the permit entry and a wait/timeout decision. I will edit `src/prompt/prompt.ts` once a decision is recorded.

## Answered

### Should the TUI move to a production TUI framework (e.g. ink), or stay hand-rolled and fix the flicker in place? (asked by director 2026-10-01)

The user reported the whole TUI flickers on every table update and said: "If we're not using a real production-grade TUI rendering framework I think we should find a good one and use it. Otherwise perhaps this is just a bug." We are hand-rolled — src/ui/tui.ts (~620 lines) plus tui-frame.ts, tui-input.ts, and eight tui-*.test.ts files, zero runtime dependencies — so the condition for adoption is met on its face. But adopting a framework (ink = React + a dependency tree; blessed = similarly large) directly overrides PRINCIPLES.md's first principle, "Zero runtime dependencies: node built-ins only", and rewrites a working, fully tested TUI.

The flicker itself is not a framework gap: it is one concrete bug — every changed frame writes `\x1b[2J` (erase whole screen) before redrawing (src/ui/tui.ts:73, :299) — fixable in place with home-position overwrite + `\x1b[K` or per-line diffing, no dependency needed. Recorded as a BUGS.md open entry so the fix lands either way.

- **Option A (recommended):** fix the repaint in place (the recorded bug). Keeps zero deps, one small change, removes the flicker. Revisit a framework only if the TUI keeps accruing framework-grade machinery (layout, focus, resize) that hand-rolling makes painful.
- **Option B:** adopt a framework (e.g. ink) — plan it as split sub-plans (dependency introduction + renderer rewrite + test migration) and amend PRINCIPLES.md's zero-deps carve-out to name the TUI. Larger, riskier, but gives diff-based rendering, layout, and input handling for free.

Recommendation: A first — fix the bug, see whether the flicker was the whole complaint; escalate to B only if the TUI's needs outgrow the hand-rolled renderer.

**Answered 2026-10-01 by the user: Option B — adopt a production TUI framework (ink).** The
hand-rolled renderer is retired in favor of ink. PRINCIPLES.md's dependency principle now names
ink as an explicit exception, and the migration is planned in PLANS.md as three
cross-referencing sub-plans ("The TUI moves to ink", parts 1/3–3/3). The flicker bug in BUGS.md
is fixed by that migration (part 1's diff-based rendering) rather than the in-place repaint,
which is shelved.

### Release the stale refusal on "Operator backlog writes land on main, part 2/2"? (asked by plan 2026-10-12)

PLANS.md `## Planned` holds one entry, "Operator backlog writes land on main, part 2/2", and it
carries **Refused 2026-10-12 by feature: prerequisite part 1/2 has not landed**. That objection
is stale: part 1/2 landed as 11ddb628 ("Commit operator-filed plans and bugs to main on
filing"). `src/backlog/backlog-commit.ts` exists, and `commitOperatorBacklogEdit` is called from
`announceFiled` and `releaseAndAnnounce` (`src/backlog/backlog-cli.ts`), the dashboard filing
handler, the TUI's Ctrl+N, and `src/brief/brief-edit.ts`. `tumwater doctor`'s refusals row already
says the refusal may be stale. The refusal landed before the `entry_refused` notify event
existed, so the notify hook never paged about it. Only a human or the director can lift a
Refused note, so the feature loops will skip this plan until one of them does.

The gap part 2/2 closes is still open. `plan|bug --cancel`, `plan|bug --edit`, and
`questions answer` write the primary checkout without committing. A cancelled entry therefore
still reads as eligible on main, and an answered question stays open in every loop's worktree.
That includes this question: answering it with `tumwater questions answer` will not reach the
loops until part 2/2 lands.

- **Option A (recommended):** run `tumwater plan --release 1`. It lifts the note, commits the
  release on main, and wakes the feature loop, which then implements part 2/2 as planned.
- **Option B:** cancel the entry (`tumwater plan --cancel 1`) if operator cancel/edit/answer
  should stay uncommitted.
- **Option C:** leave it refused. No loop takes the plan, and the gap stays.

Recommendation: A. The refusal's only reason no longer holds, and the plan was written against
the part 1/2 code that is now on main.

**Answered 2026-10-12 by operator:** I ran tumwater plan --release 1 (option A)

### What flag should scope `tumwater logs`' event feed to some roles? (asked 2026-10-19 by the plan role)

**Context.** The dashboard's event search (`GET /api/logs?role=<id>`, `handleLogs` in
src/gui/gui-endpoints.ts) and the TUI Activity pane (Ctrl+G, exact-role scope in
src/ui/tui/tui-pane-activity.ts) both filter the event feed by role through `eventRole`. The
CLI's `tumwater logs` cannot: `--role <id>` already switches it to that role's pi transcript, and
`rejectRoleViewRival` (src/cli/log-commands.ts) rejects `--role` alongside every event-feed flag
(`--grep`, `--type`, `--since`, `--count`, `--json`). Today the nearest workaround is
`--grep feature`, which also matches other roles' lines that mention the word. Whatever name is
picked takes a comma list like `history --role clean,dedupe`.

**Options.**
1. A new event-feed flag, e.g. `tumwater logs --from clean,dedupe [-f] [-n N] [--type …]`. This
   adds a flag and leaves `--role` as it is.
2. Make `--role` filter the event feed and move the transcript to its own flag,
   e.g. `tumwater logs --transcript <id> [--prompt]`. This matches `history --role`, but it breaks
   existing `logs --role` scripts and docs.
3. Leave it: `--grep` is close enough, and the dashboards already cover the case.

**Recommendation.** Option 1 (`--from`): it adds a flag without breaking anything and reads
naturally ("events from clean"). Once a name is chosen, the plan role will plan it as one
change: parse it with `parseRoleListFlag`, add it to `feedFilter` in `cmdLogs`, and update
help/docs/completion.

**Answered 2026-10-19 by the user:** Let's go with option 2, Make --role filter the event feed and move the transcript to its own flag

### Release the stale refusal on the "Newest failure" dashboard plan? (asked by director 2026-10-21)

PLANS.md `## Planned` holds "Dashboard History gains a Newest failure button that opens the
team's newest failing run, the `history --last --result problems` twin" under **Refused
2026-10-21 by feature: the finished plan kept being rejected for landing in the archive
(PLANS-DONE.md) instead of PLANS.md's ## Done, the review chain hit its cap, and tumwater's
rejection directs not to re-author this theme**. That objection is stale. The review chain's
rejections were three backlog-file bugs, all filed from this plan's chain and since fixed on
main: the commit-time archive sweep moving a finished plan out of the gate's view (BUGS-FIXED.md
"The commit-time archive sweep moves a finished plan into PLANS-DONE.md after the self-check and
before the commit…", fixed 2026-10-21); the backlog-structure gate's archive message naming the
wrong repair (BUGS-FIXED.md "The backlog-structure gate tells an author whose finished plan is
already archived to 'file it under `## Planned` in PLANS.md instead'…", fixed 2026-10-21); and
the closing-stamp wording that made a finished plan read "— fixed" where the reader needs "—
done" (BUGS-FIXED.md "Every role's prompt says a closing date reads '— fixed YYYY-MM-DD by the
<role> role'…", fixed 2026-10-21). The "PLANS vs PLANS-DONE" the note names was the visible
symptom of those bugs, not a fault of the plan; the refusal's cause no longer exists. The
refusal discarded the run's implementation — `handleRefusal` (src/verdict/refusal.ts) commits
only the markdown note and resets the worktree — so the plan must be re-implemented, not
resumed. Its text is intact and it is independent of every eligible plan.

- **Option A (recommended):** `tumwater plan --release <position>` (the first planned plan
today) — lifts the note and wakes the feature loop, which implements the plan as written.
- **Option B:** `tumwater plan --cancel <position>` if the button is no longer wanted.
- **Option C:** leave it refused. Every feature loop skips it and the gap stands.

Recommendation: A. The plan is the last consumer of the role-less `GET /api/run?last=1`
endpoint and a small, self-contained UI change; the only reason it was parked was a set of
backlog-file bugs that were fixed the day it was refused.

**Answered 2026-10-21 by the user:** Let's go with your recommendation, option A

### The shared host sits at the load-flaky e2e ceiling and the durable fix is a fork: deterministic spawn observation, isolation, or exempting the known-load-flaky budget members from the full-e2e gate? (asked by the steward role 2026-10-28)

**Context.** The load-flaky e2e class (BUGS.md 70-141) records the `/e2e/concurrency` tier going red for many consecutive main tips because the shared host (load avg ≈105–190, much of it the team's own agents and their full-width suites — see the `maxConcurrentChecks` bypass, BUGS.md 239-253) outstrips what the wall-clock concurrency tests tolerate. The landed deterministic-contention re-points retired three members, but the budget members (`a reached cap switches roles to the free fallback model instead of stopping them` and `a free fallback whose runs keep failing is demoted to a pause, then probed back once it serves`), the two resize grow-waits and the permits overlap still flake at the ceiling. Two wall-clock lengthenings (60 s → 150 s) have each failed on the same reached-cap member, so the class entry's 2026-10-28 gate records that no finite wall-clock bound can guarantee green while the host sits at the ceiling — further lengthening is a losing arms race. Today the ci role recorded the budget members again (~151–157 s at load ≈100–124, BUGS.md line 140) and a `once` round blew its 30 s hang guard at load ≈164 (BUGS.md 271-276), so the fork is unresolved and the e2e step stays red while the host is loaded.

**Options.**
1. **Deterministic spawn observation** — make the post-switch spawn witness a harness-controlled signal instead of the host's real spawn schedule, where the member's point lets that be honest. The engineering-clean fix, but parts of it measure the host's real scheduling and need a large harness change.
2. **Isolate the load-sensitive e2e** (budget/resize/permits/once) from the full-suite and agent load that holds the host at the ceiling — e.g. gate the agents' own suite runs with the same `maxConcurrentChecks` permit (BUGS.md 239-253) and/or run these e2e on a quieter gate. Preserves the "every commit is verified" guarantee and stops the arms race; changes the gate's structure and depends on actually lowering host load.
3. **Exempt the known-load-flaky members** from the full-e2e gate as an explicit documented known-flaky list, leaning on the deterministic members and the doctor. Lowest effort, but it directly weakens the verification guarantee the active "Every commit is verified on main" plan series is building.

**Recommendation.** Option 2 (isolation). It is the one choice that preserves the verification guarantee the current plan series delivers while ending the bound-lengthening arms race, and it can be started with the `maxConcurrentChecks` permit fix already filed (BUGS.md 239-253). Choose option 3 only if isolation is deliberately not wanted, since it relaxes a guarantee the team is actively building; option 1 remains the right long-term fix for the members a harness can genuinely drive.

**Answered 2026-10-28 by the user:** Let's go with option 2, isolate.
