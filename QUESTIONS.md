# Questions

Open questions loops have posted for a human decision — each with context, the options, and the
loop's recommendation. Answer by moving an entry to ## Answered with your decision (or tell the
director). Loops never block on their own questions; they check here at the start of each tick.

## Open

### Should the TUI move to a production TUI framework (e.g. ink), or stay hand-rolled and fix the flicker in place? (asked by director 2026-10-01)

The user reported the whole TUI flickers on every table update and said: "If we're not using a real production-grade TUI rendering framework I think we should find a good one and use it. Otherwise perhaps this is just a bug." We are hand-rolled — src/ui/tui.ts (~620 lines) plus tui-frame.ts, tui-input.ts, and eight tui-*.test.ts files, zero runtime dependencies — so the condition for adoption is met on its face. But adopting a framework (ink = React + a dependency tree; blessed = similarly large) directly overrides PRINCIPLES.md's first principle, "Zero runtime dependencies: node built-ins only", and rewrites a working, fully tested TUI.

The flicker itself is not a framework gap: it is one concrete bug — every changed frame writes `\x1b[2J` (erase whole screen) before redrawing (src/ui/tui.ts:73, :299) — fixable in place with home-position overwrite + `\x1b[K` or per-line diffing, no dependency needed. Recorded as a BUGS.md open entry so the fix lands either way.

- **Option A (recommended):** fix the repaint in place (the recorded bug). Keeps zero deps, one small change, removes the flicker. Revisit a framework only if the TUI keeps accruing framework-grade machinery (layout, focus, resize) that hand-rolling makes painful.
- **Option B:** adopt a framework (e.g. ink) — plan it as split sub-plans (dependency introduction + renderer rewrite + test migration) and amend PRINCIPLES.md's zero-deps carve-out to name the TUI. Larger, riskier, but gives diff-based rendering, layout, and input handling for free.

Recommendation: A first — fix the bug, see whether the flicker was the whole complaint; escalate to B only if the TUI's needs outgrow the hand-rolled renderer.

## Answered

_None yet._
