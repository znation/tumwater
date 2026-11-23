# Principles

Design principles this project holds — the codified answer to "what would a senior engineer on
this team always do." Only the director and steward roles may edit this file; phrase new
principles positively.

- Zero incidental runtime dependencies: node built-ins only. The dev-time TypeScript toolchain is
  the only exception, adopted by an explicit user decision. Any new one needs a user decision
  recorded in Budgets. (The ink TUI framework was a runtime exception from 2026-10-01 until the TUI
  was removed; it is no longer one.)
- Tests run offline against a fake pi shim on PATH; never call a real model from a test.
- All git operations belong to the harness, never to pi: loop prompts forbid state-changing git
  commands; the harness owns commit/rebase/merge.
- Prefer one sensible way of doing things over a knob: ship an opinionated default first.
- Small, complete, and correct beats big and half-done: one focused change per run. Focused means
  one theme, not one site — a kind of fix applied everywhere it holds is one change; landing it
  one site per run spends a review and a landing on each.
- Return oversized work to its planner: a backlog entry a work role reports too large for one run
  goes back to the plan role to refine and split, not to the operator to release.
- Let the latest instruction win: a newer user request supersedes older recorded bugs, plans, and
  docs — synthesize it with the existing entries and update them in place.
- Surface refusals as decisions, not alarms: show a refused entry as a **Question** when it is
  the operator's call, or self-heal it when the system can settle it — raise a UI warning only
  for what the operator must act on.
- Build the team to be steered through the backlog, not left alone: the operator, usually through
  their own agent, writes, sharpens, reorders, and retires PLANS.md and BUGS.md entries, and the
  team builds them well. Treat an operator-written entry as the operator's intent — build or
  refine it, raise a **Question** when it looks wrong, and keep the docs, prompts, and UI
  describing a steered, never hands-off, team.

## Budgets

The steward's standing measure of where the codebase stands, measured from the repo, not vibes — refresh with `wc -l` and `find` when touched.

- **Code size**: 503 src / ~130,800 lines; 662 test / ~201,900 lines. Grows with every merge; the
  split-large-function family is the standing driver of per-function (not per-file) growth. The
  figure fell on 2026-11-20 when the ink TUI was removed (~25,500 lines across 131 files).
- **Module-size ceiling**: 31 src files exceed 600 lines, 10 exceed 700, 3 exceed 800; the largest
  is src/cli/cli-help-text.ts at 947, with src/backlog/backlog-write.ts at 806. The ceiling holds
  because complexity is extracted into named helpers, not by shrinking files — a file may stay
  large while its functions stay small; do not re-split an already-small function to chase a line count.
- **Dependencies**: 0 runtime and 5 dev, all dev-time (typescript + its `typescript-native`
  alias, eslint, typescript-eslint, @types/node). Zero incidental runtime deps: any new one needs a
  user decision recorded here.
- **Per-function complexity**: the split-large-function family is the main complexity pressure —
  289 such plans have landed (`## Done` `### ` headings containing "is split into"). A
  split earns a plan only when a named function is genuinely large and a reader's question is
  answered better by a name; a complexity-N number alone is not the reason. This keeps the family
  finite, not a bottomless re-split.

_Last measured 2026-11-23 by the steward role from main's tip (code size, module-size ceiling and
split count); dependencies re-measured the same day from main's package.json._
