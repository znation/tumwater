# Questions

Open questions loops have posted for a human decision — each with context, the options, and the
loop's recommendation. Answer by moving an entry to ## Answered with your decision (or tell the
director). Loops never block on their own questions; they check here at the start of each tick.

## Open

### Should a stuck run unstick itself — by escalating to a stronger model, or by the harness killing the hung call and proceeding? (asked by director 2026-11-11)

**Context.** The user saw the amber team alert `feature #2 looks stuck` / `tool call stalled: bash node --test dist/test/cli-confi… for 15m43s` and said: "When something is stuck, it should unstick itself instead of complaining to the user that it's stuck. Perhaps by escalating to the Director role or strong(er) model? Or if it's waiting on a tool call, decide whether it really means 'stuck' in this context and if so, kill it and proceed from there?"

**What the code actually does today** (verified in this worktree):

- The amber `looks stuck` banner is a *display-only* warning. It rides the in-flight run's rendered phase label — `inFlightDetail` in `src/ui/run-progress-model.ts` appends `tool call stalled: <tool>` (a call silent past `toolCallStallSeconds`, default 300 s) or, for a non-streaming backend like claude, `tool call stalled: <tool> — no exit for <d>` once the call is open past `bufferedCommandStallMs` = max(2×300 s, 10 min) in `src/pi/command-shape.ts`. The alert fires the moment that stall *phrase* is rendered (`STALL_RE` matched in `pushStuckRoleAlert`, `src/ui/team-alert-status.ts`); the alert has no `kill` action, only `Open feature #2`.
- The **stall warning is warn-only. It does not kill.** `warnStalledToolCalls` in `src/pi/pi-watchdogs.ts` only calls `onStallWarning`; the interval that kills (`startQuietWatch`) kills on *total* silence for `quietTimeoutSeconds` (default 1800 s = 30 min), keyed to `progressCount()`, not on a single hung tool call. So a run whose single tool call has been hung 15 m still shows `looks stuck` — and the banner keeps saying it — until the quiet watchdog fires (15 m–45 m from now, depending on whether any other output is trickling). That is exactly the "complaining that it's stuck" the user saw.
- When a kill does happen the run is already *self-healing* (kill + proceed), just too slowly: `quietKillArm` in `src/run/run-verdict.ts` returns `quiet_killed`, `scheduleQuietKilledOutcome` in `src/run/run-apply.ts` sets `resumeCause: "hung-tool"` and resumes the intact session *promptly*, and the `hung-tool` branch of `buildResumePrompt` in `src/prompt/prompt-followup.ts` tells the (same-tier) session its run died on a stalled tool call and warns against re-running that command unchanged. The model is the same tier — it is not a *stronger* model.
- The *model side* of the user's request is **already implemented**: an unanswered model request already triggers the model check to re-check the pair and, if it fails, hand the run back to the fallback/stronger seam (`onUnansweredReply` in `src/runner/runner-pi.ts` → `RoleRunner.unansweredRunPair` → `src/model-check/model-check-gate.ts`; and the open `One unavailable model pair stops only the roles on that pair, part 1/2` in PLANS.md completes that). So "escalate the model" for a *no model reply* stall is done; the gap is the *tool-call* stall.

**The real fork.** The screenshot is a **tool call** stall, and the user offered several different remedies. They are not interchangeable — each is a different, nontrivial change to the run lifecycle (the harness's most load- and false-positive-sensitive code; the quiet watchdog carries a long list of BUGS.md hard-won fixes for false kills, so a new kill trigger lands carefully), and the cost is real: a wrong kill discards an in-flight author run's session and edits (a "restart, not discarded work," but still slot time), while an under-trigger leaves the banner up. This is a product-direction call, not a guess, so it is recorded here.

- **Option A — kill + resume (harness, same model, no escalation).** Make a tool call that stays hung past a *generous* wall-clock bound (distinct from the existing warn-only `bufferedCommandStallMs`; longer, since it now kills — e.g. ~2× the quiet window) *kill* the run's process tree and let the existing `quiet_killed` / `hung-tool` resume path take over promptly, instead of waiting for total silence. This is the most direct read of "kill it and proceed from there," is fully in the harness's power, and turns `looks stuck` into "unstuck itself" for the common case (a hung `npm test`/`node --test`). It does **not** escalate the model. One focused change: `src/pi/pi-watchdogs.ts` (new per-call kill bound + a `stallKilled`-style flag), the settle path, `resolveRunVerdict`'s `quietKillArm`, and `RunnerState.resumeCause` gaining a `stalled-tool` variant so the bridge prompt can say *the specific tool* was killed (distinct from the "no progress at all" quiet kill). Must not fire on a call that is slowly progressing.
- **Option B — escalate to the strong model / Director (model-tier).** Re-run the *same* session on the **strong tier** (the Director's model, which the harness can already reach — `buildSummaryRequestPrompt`-style bounded follow-ups, and the image-reroute already re-runs on a peer tier) when a tool call is stalled, letting the stronger model break the deadlock and finish the task. This is the "strong(er) model" arm of the request; the existing `hung-tool` resume is a same-model retry, so this is the genuinely new behavior. Heavier and riskier: it spends the strong model (the Director's budget), and "a stronger model re-running a hung command" may just hang the same way — so it must be bounded (one escalation, then the Option A kill, then fresh). It also touches the model-tier machinery the in-flight model-check / model-pair plans are already editing, so it lands **after** those to avoid a review conflict.
- **Option C — leave it (tighten the bound only).** Treat the banner as honest: the quiet watchdog already kills a *totally* stuck run within 15 m–30 m and resumes. The only change is lowering `quietTimeoutSeconds` or the stall bound so the self-kill lands sooner and the banner's lifetime shortens. No new mechanism, least risk, but it does not add the escalation the user proposed and still costs the gap before the quiet window closes.

**Recommendation. Option A**, with a bounded **Option B** as an explicit follow-up sub-plan ("after part A landed") if the user wants the escalation. A is what "kill it and proceed from there" most plainly means, it is entirely in the harness's control, and it makes the banner's complaint self-resolving for the common hung-tool case within a bounded time rather than leaving the user to read it. B is the model-side upgrade the user also raised, and it composes cleanly on top of A (escalate once, then kill+resume). C is the conservative floor if neither is wanted. I will turn the chosen option into a sized plan (one sub-plan per landing unit) as soon as it is answered; the model-side re-check arm needs no plan (already built).

**Answer:** (awaiting the user)

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
`announceFiled` and `releaseAndAnnounce` (`src/cli/backlog-cli.ts`), the dashboard filing
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
`rejectRoleViewRival` (src/cli/cli-log-commands.ts) rejects `--role` alongside every event-feed flag
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

### Should agent runs keep verifying with the full `test:gate`, or switch to targeted tests and leave the full gate to the team's own check? (asked by the bugfix role 2026-10-28)

**Context.** BUGS.md lines 241-245 ("Decide whether agent runs keep verifying with the full `test:gate`") — split by the plan role from the `maxConcurrentChecks` bypass — is a policy call about the verification guarantee, so a run must not change it unilaterally. The run prompt's verify rule (`src/prompt/prompt.ts`) has every agent run execute `npm run test:gate`, and the team then runs the same gate check on the change (the merge checks, `src/build/build-check.ts`), so each change's suite runs twice and agents add 1.3–1.7 full-width suites in flight against a host already at the load-flaky ceiling (load avg ≈105–190; 965/915 full suite runs a day on 10-23/10-24). This is separate from (though it shares the load pressure with) the steward's open question above, whose recommendation Option 2 proposes gating agents' suites with the `maxConcurrentChecks` permit instead.

**Options.**
1. **Keep `test:gate` on every agent run** (status quo). Strongest per-run verification, but each change's suite runs twice and contributes the most load pressure; the team's own gate then re-runs the same work.
2. **Drop the agent-side `test:gate`, run targeted tests only** (the entry's stated expectation). Each change is still verified by the team's own full-gate check on merge, preserving the "every commit is verified on main" guarantee while roughly halving the duplicative suite load and cutting most of the agents' in-flight contribution.
3. **Keep `test:gate` but gate it behind the `maxConcurrentChecks` permit** (BUGS.md permit entry, steward's Option 2). Preserves per-run verification but queued runs can hang past a run's own bash cap, and it depends on the permit entry landing and on actually lowering host load.

**Recommendation.** Option 2 (drop the agent-side full gate, target instead). The team's own gate check on main already delivers the "every commit is verified on main" guarantee the active plan series builds; the agent-side re-run is the duplicative half and the biggest single contributor to the agent-load that holds the host at the flaky ceiling. If the team wants per-run full verification preserved anyway, Option 3 (permit-gated) is the load-honest form — but it needs the permit entry and a wait/timeout decision. I will edit `src/prompt/prompt.ts` once a decision is recorded.

**Answered 2026-10-28 by the user:** Let's go with option 2, drop the agent-side test:gate, run targeted tests only

### When bugfix cannot make a bug reproduce, which hand-off comes first: a director (strong-tier) review, or a needs-review park? (asked by the director 2026-10-30)

**Context.** The user observed bugs that could have been clarified and reviewed by a stronger model (the director) reaching them instead, and asked: "When the bugfix role kicks a bug back to the user for review, it should first try to have the director role do the review. Only if that fails, should the director then kick it back to the user for review." There is no such kick-to-user today: bugfix's only escalation is a `**Needs review <date> by bugfix: …**` note appended under the BUGS.md heading (role-catalog.ts `bugfix` find step 2) that parks the entry `[blocked: needs review]` until selfcheck finds a new occurrence, records it, and deletes the note (docs/how-it-works.md; selfcheck find step 4), at which point bugfix may retry. A running role's agent also has no sanctioned way to enqueue a director run — only the operator surfaces (`tumwater prompt`, the TUI/GUI composer) can write the director's inbox via `submitRolePrompt`/`submitRolePromptAndWake` (src/inbox/inbox-submit.ts, src/operator/operator-intent.ts) — so a "first try the director" step needs a hand-off the roles can actually perform, and the "then kick to the user" fallback needs a defined user surface (a needs-review park, a Questions.md entry, a director inbox message, or a Refused-style note).

**Options.**
1. **The bugfix agent enqueues a director prompt directly** — a role's find text gains a step that, when it cannot reproduce, calls the existing `enqueueRolePrompt(root, DIRECTOR_ROLE, …)` to send the director the entry, its findings, and a request to clarify/verify, and only if the director declines (or the prompt mechanism is unavailable offline, in tests) parks it with the existing by-bugfix needs-review note. Direct, but it changes what a role's commands may do (roles today never write the director's inbox) and the "if the director fails" branch needs a definition — the director has no verdict hook to decline a queued request.
2. **The by-bugfix needs-review park becomes a director-review trigger** — the note names `by director: …` when a stronger model should look first; an added weak tier/director consumer of needs-review BUGS.md entries does the clarifying review and lifts the note (or rewrites it toward the user) when it cannot resolve. Preserves today's park shape, but needs new scheduling (who consumes by-director notes) and still lacks an explicit user fallback.
3. **Route through a Questions.md entry** — bugfix posts an `(asked by bugfix …)` question describing the reproduction gap, which the director (a strong-tier reader, per the routes) answers by clarifying/verifying or by forwarding to the user; the questions-outbox already gives a real user-answer path. Matches the "stronger model first, user only if it fails" goal with existing machinery, but is heavier than a note for plain bug triage.

**Recommendation.** Option 1, shaped as a plan: add to the bugfix find text a step that tries `submitRolePrompt`/`enqueueRolePrompt` to the director with the entry, the attempted reproductions, the failure message, and a precise request ("clarify, verify, or mark it unresolvable"); treat "the director could not resolve" as the director saying so back through the existing channels (a question, a rejection, or a note), and make the user fallback explicit — the by-bugfix needs-review park stays as the last resort, or a Questions.md entry is posted. A plan must decide the concrete director-verdict contract and the user fallback's exact form before implementation, and the decision is genuinely the user's (it changes what roles may do), so this is recorded as a question rather than guessed. Once the mechanism is chosen, the plan lands as one change: bugfix find text + director-routing text + prompt-contract tests.

**Answered 2026-10-30 by the user:** Let's go with your Recommendation: Option 1, shaped as a plan: add to the bugfix find text a step that tries submitRolePrompt/enqueueRolePrompt to the director with the entry.
