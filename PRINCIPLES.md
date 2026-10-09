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
- Latest instruction wins: a newer user request supersedes older recorded bugs, plans, and docs —
  synthesize it with the existing entries and update them in place so the record reflects current
  intent.
