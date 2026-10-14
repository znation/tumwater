# Questions

Open questions loops have posted for a human decision — each with context, the options, and the
loop's recommendation. Answer by moving an entry to ## Answered with your decision (or tell the
director). Loops never block on their own questions; they check here at the start of each tick.

## Open

_None yet._

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
handler, the TUI's Ctrl+N, and `src/brief-edit.ts`. `tumwater doctor`'s refusals row already
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
