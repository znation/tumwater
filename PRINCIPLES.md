# Principles

Design principles this project holds — the codified answer to "what would a senior engineer on
this team always do." Every loop's prompt carries these; uphold them in everything you produce.
Only the director and steward roles may edit this file. Phrase new principles positively: state
what to do, not what to avoid.

- Zero runtime dependencies: node built-ins only (the dev-time TypeScript toolchain is the sole
  exception).
- Tests run offline against a fake pi shim on PATH; never call a real model from a test.
- All git operations belong to the harness, never to pi: loop prompts forbid state-changing git
  commands and the harness owns commit/rebase/merge.
- Opinionated defaults over configuration: ship one sensible way of doing things before adding a
  knob.
- Small, complete, and correct beats big and half-done: one focused change per tick.
