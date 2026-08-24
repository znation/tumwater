# QA role — exercising the product like a user

Planned 2026-08-24 · from the "Senior Tumwater" report (HN 49421554) · report item R6b

## Goal

A `qa` role that never edits source: it builds and runs the actual product the way a user would —
following the README verbatim, driving the CLI and any endpoints — and files reproducible bugs in
BUGS.md when reality disagrees with the docs or with reasonable expectations. It closes the gap
between "the diff merged" and "the product works".

## Motivation

HN commenter **kilroy123**: even frontier-lab products "feel vibe coded" — nothing exercised them
end-to-end. **ben_w**: LLMs are weak at testing and validating problem-fit; a role whose only job
is validation compensates structurally. Tumwater's unit suite is strong (180+ tests) but nothing
ever runs the built artifact the way a person does — the broken-GUI-page incident shipped through
a green suite precisely because no consumer of the page existed in CI.

## Design

- **Role** (`src/roles.ts`): id `qa`, title "product QA", after `perf` in catalog order. Find
  prompt, in spirit: "Act as a first-time user. Follow README's usage instructions literally in a
  scratch directory: build, run the CLI commands, exercise endpoints with curl, check outputs
  against what the docs promise. Pick ONE flow per tick. When something is broken, confusing, or
  diverges from the docs, record a reproducible bug in BUGS.md (exact commands, expected vs
  actual). You never edit source, tests, or docs — BUGS.md is your only write. If the flow works
  as documented, there is nothing to do."
- **Safety rails** (already largely in place, referenced explicitly in the prompt): the
  no-indefinite-commands rule and the progress watchdog protect against hung runs; the prompt
  additionally requires every launched process to get a hard time limit and a kill, servers to use
  ephemeral high ports (never the user's 7180), and scratch dirs under the system temp — never the
  project worktree, never `.tumwater/`.
- **Self-hosting wrinkle**: QA of tumwater means running `tumwater init/run/status` in a scratch
  git repo with the fake-pi shim pattern or a real single tick against the configured model —
  the prompt permits either but caps a real tick's budget explicitly.
- **Cadence**: reuse the per-role `minTickIntervalSeconds` override from
  [steward-role.md](steward-role.md); default 7200 (2 h) — user flows change slower than code.
- **Cheap merges**: BUGS.md-only diffs are review-exempt md under
  [review-gate.md](review-gate.md); the bugfix loop consumes the filings through its existing
  find prompt, completing the loop QA → bug → fix → (reviewed) merge.

## Files touched

`src/roles.ts`, `tumwater.json` (enable + cadence), `test/qa-role.test.ts` (prompt contract:
BUGS.md-only writes, time-limit and ephemeral-port rules, one-flow-per-tick), README roles list.

## Acceptance criteria

- The qa role exists with the write restriction, safety rails, and one-flow scope in its prompt;
  tests assert the contract text.
- Dogfood: a deliberately planted doc/behavior mismatch (e.g. a README flag that doesn't exist)
  is discovered and filed in BUGS.md within a few qa ticks — verified by observation.
- No qa tick ever leaves a listening process behind (observable via the process table after its
  ticks). `npm test` passes.

## Dependencies & sequencing

Last in the report's sequence: wants the watchdog (done), the per-role cadence override
([steward-role.md](steward-role.md)), and ideally the review gate in place. Riskiest item to run
safely; the rails above are the mitigation.

## Out of scope

Editing anything but BUGS.md; browser automation (curl-level checks only for now); performance
testing (perf role's territory); acting on its own filings.
