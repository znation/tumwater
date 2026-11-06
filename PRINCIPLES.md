# Principles

Design principles this project holds — the codified answer to "what would a senior engineer on
this team always do." Every loop's prompt carries these; uphold them in everything you produce.
Only the director and steward roles may edit this file. Phrase new principles positively: state
what to do, not what to avoid.

- Zero incidental runtime dependencies: node built-ins by default; the dev-time TypeScript
  toolchain and the TUI rendering framework (ink) are the only exceptions, each adopted by an
  explicit user decision (2026-10-01 for ink).
- Tests run offline against a fake pi shim on PATH; never call a real model from a test.
- All git operations belong to the harness, never to pi: loop prompts forbid state-changing git
  commands and the harness owns commit/rebase/merge.
- Opinionated defaults over configuration: ship one sensible way of doing things before adding a
  knob.
- Small, complete, and correct beats big and half-done: one focused change per tick. Focused
  means one theme, not one site: a kind of fix applied everywhere it holds is one change, and
  the same fix landed one site per tick spends a review and a landing on each.
- Oversized work returns to its planner: a backlog entry a work role reports too large for one run
  goes back to the plan role to refine and split, not to the operator to release.
- Latest instruction wins: a newer user request supersedes older recorded bugs, plans, and docs —
  synthesize it with the existing entries and update them in place so the record reflects current
  intent.

## Budgets

The steward's standing measure of where the codebase stands (measured from the repo, not vibes —
refresh the numbers with `wc -l` and `find` when this section is touched, and note the date).

- **Code size**: 505 src modules / ~123,000 lines; 636 test modules / ~183,000 lines. Trend:
  grows with every merge; the split-large-function family below is the standing driver of
  per-function (not per-file) growth.
- **Module-size ceiling**: 21 src files exceed 600 lines, 7 exceed 700, 2 exceed 800; the largest
  is src/roles/role-view.ts at 882. The ceiling holds because complexity is extracted into named
  helpers, not by shrinking files — a file may stay large while its functions stay small; do not
  re-split an already-small function to chase a line count.
- **Dependencies**: 2 runtime (ink, react) — the ink decision of 2026-10-01 and the react that
  ships with it; 6 dev, all dev-time: the TypeScript compiler (typescript, plus its
  `typescript-native` alias to the native compiler), the lint tooling (eslint, typescript-eslint),
  and the type packages for node and react (@types/node, @types/react). Zero incidental runtime
  deps: any new one needs an explicit user decision recorded here, matching the principle above.
- **Per-function complexity**: the split-large-function family is the team's main complexity
  pressure — 237 such plans have landed (counted as `## Done` headings that name a body "split
  into" named steps or one named helper per concern) and more sit in `## Planned`. A split earns a
  plan only when a named function is genuinely large and a reader's question is answered better by
  a name; a complexity-N number alone is not the reason. This keeps the family finite instead of a
  bottomless re-split of already-named helpers.

_Last measured 2026-11-06 by the steward role._
