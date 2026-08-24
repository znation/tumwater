# PRINCIPLES.md — the project's taste, phrased positively

Planned 2026-08-24 · from the "Senior Tumwater" report (HN 49421554) · report item R3

## Goal

Every tumwater project carries a tracked `PRINCIPLES.md`: the codified answer to "what would a
senior engineer on this team always do," injected into every tick prompt so all loops share one
standard of taste. It is the canonical home for durable user guidance and the lint standard the
review gate (see [review-gate.md](review-gate.md)) checks diffs against.

## Motivation

HN commenter **chermi**: LLMs are bad at following prohibitions and work best off positive
constraints — keep a "bias field" of design principles to lint outputs toward consistency.
**dd8601fn**: knowing what *not* to do is the high-value expertise. Today tumwater's standing
constraints are scattered across `COMMON_RULES` in src/prompt.ts and README fragments; per-role
`instructions` in tumwater.json exist but are per-role and unversioned prose.

## Design

- **Template at init** (`src/init.ts`): seed `PRINCIPLES.md` beside PLANS.md/BUGS.md with a short
  header explaining its purpose and 3–4 starter principles phrased positively (e.g. "prefer the
  standard library over a new dependency", "keep every module under ~500 lines", "every behavior
  change ships with a test"). Add to the init commit and to `initProject`'s created-files list.
- **Injection** (`src/prompt.ts`): new `readPrinciples(root)` reads the file (cap at ~4,000 chars,
  clipping with a note so a runaway file cannot blow up every prompt). `buildTickPrompt` and
  `buildDirectorPrompt` include it as a `<principles>` block introduced as "design principles this
  project holds — uphold them in everything you produce". Positive framing preserved verbatim.
- **Write policy**: only the director (routing durable user guidance) and the steward role
  ([steward-role.md](steward-role.md)) may edit PRINCIPLES.md. Add to `COMMON_RULES`: all other
  roles treat it as read-only; if a principle seems wrong, question it via the questions outbox
  ([questions-outbox.md](questions-outbox.md)) or a PLANS.md note rather than editing.
- **Director routing** (`src/prompt.ts`): the routing block's "guidance, decision, or constraint"
  bullet points at PRINCIPLES.md first, README/PLANS/BUGS otherwise.
- **Self-hosting**: seed this repo's own PRINCIPLES.md as part of the implementation (zero runtime
  dependencies; offline tests via the fake-pi shim; all git operations belong to the harness, never
  to pi; opinionated defaults over configuration; one focused change per tick).

## Files touched

`src/init.ts`, `src/prompt.ts`, `src/roles.ts` (readme role: keep PRINCIPLES.md out of its
status-section remit), `test/init.test.ts`, `test/prompt.test.ts`, `PRINCIPLES.md` (this repo),
README ("How it works" mention).

## Acceptance criteria

- `tumwater init` creates PRINCIPLES.md (never clobbering an existing one) and commits it.
- Every role prompt and the director prompt contain the file's text inside a `<principles>` block;
  a unit test asserts presence and the clipping behavior at the cap.
- COMMON_RULES forbids non-director/steward edits; a prompt test asserts the rule text.
- This repo has a seeded PRINCIPLES.md. `npm test` passes.

## Dependencies & sequencing

None — this is the first item of the report's sequence; review-gate.md and
refusal-and-thrash.md both consume it.

## Out of scope

Automated enforcement of specific principles (that is the review gate's job); complexity metrics
(steward's job).
