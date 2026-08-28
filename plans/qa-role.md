# QA role — exercising the product like a user

Planned 2026-08-24 · refined 2026-08-26 (self-hosting mechanics: built-CLI invocation,
constrained nested run) · refined 2026-08-28 (flow selection across fresh sessions; cadence-
knob sequencing — the knob lands with whichever of qa/steward comes first) · from the "Senior
Tumwater" report (HN 49421554) · report item R6b

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
  ephemeral high ports (never the user's 7180), scratch dirs under the system temp — never the
  project worktree, never `.tumwater/` — and each scratch repo deleted when its flow is done.
- **Self-hosting mechanics** (decided): QA of tumwater tests the built product from this
  worktree: `npm install && npm run build` here first (`dist/` is gitignored and the worktree
  resets to main every tick, so there is never a stale binary), then invoke the CLI as
  `node <worktree>/dist/cli.js …` with cwd set to a scratch repo — the CLI resolves its root from
  `process.cwd()` (src/cli.ts), so no install or link step in the scratch dir. Two modes for the
  `run` flow: (a) **fake-pi shim** (the test/util.ts pattern): deterministic and cheap; covers
  init/run/status/logs/prompt mechanics end to end without touching the model server; or
  (b) **one real, bounded run**: after `tumwater init`, edit the scratch repo's tumwater.json so
  exactly ONE role is enabled and `maxConcurrent` is 1 — a default-config nested run would start
  all eleven roles with six concurrent pi clients on top of this fleet, which per the README's
  "match clients to slots" note thrashes the shared local server's prefix caches; then background
  `tumwater run`, let it complete one tick (wall cap ~10 min including prefill), kill it and its
  pi children, and verify via `status`/`logs` that the loop actually ran. The prompt states both
  caps explicitly: every `run` invocation gets a wall-clock cap plus an explicit kill of its whole
  process tree.
- **Flow selection across fresh sessions** (decided): every tick is a fresh session with no
  memory of what was tested last time, so the prompt carries an explicit ordered flow list —
  `init → status → logs → prompt → reset-counters → gui → tui → run` (the README usage block's
  flows, cheap first) — plus one rule: "Pick ONE flow per tick; vary across ticks, preferring a
  flow not recently exercised as far as your BUGS.md filings and Verified notes show." Cheap
  read-only flows leave NO record when they pass — the tick declares nothing-to-do. That is
  deliberate: a passing check is not durable knowledge, and a note commit every cadence would
  move main and wake every sleeping loop early (README: "Sleeping loops wake early when main
  moves"). Fresh-session judgment over an explicit list is enough for cheap flows — the worst
  case is re-verifying a seconds-long flow. The expensive real-pi `run` flow is the exception:
  it must not repeat daily, so it is the only success that leaves a record. When qa exercises
  the run flow in real mode it appends one line under a new `## Verified` section at the end of
  BUGS.md (e.g. `- 2026-08-28 run (real): init + one tick landed; status/logs confirm`) —
  BUGS.md remains its only write target, and the note is md-only so review-exempt. Mode rule in
  the prompt: "Use fake-pi shim mode by default; use real bounded mode only when the newest
  Verified note for the run flow is older than a day." The guard is self-enforcing across fresh
  sessions through that one file, and at most one such note commit per day moves main. `##
  Verified` cannot leak into the dashboards (openBugs parses BUGS.md's `## Open` section only)
  and the bugfix role picks open bugs, not notes.
- **Cadence**: the per-role `minTickIntervalSeconds` override specified in
  [steward-role.md](steward-role.md); qa's own entry defaults to 7200 (2 h) — user flows change
  slower than code. Sequencing decided: if that override has not landed yet, it lands WITH this
  role — the same small change steward-role.md specifies (RoleConfig field + ROLE_ENTRY_KEYS
  validation + `configForRole` fallback + defaultConfig entry + the two read sites), so neither
  plan blocks on the other; whichever of qa/steward lands first owns the knob and the second
  just adds its role. Same coordination pattern as `PiRunResult.turns` between commit-bodies.md
  and refusal-and-thrash.md.
- **Cheap merges**: BUGS.md-only diffs are review-exempt md under
  [review-gate.md](review-gate.md); the bugfix loop consumes the filings through its existing
  find prompt, completing the loop QA → bug → fix → (reviewed) merge.

## Files touched

`src/roles.ts`, `tumwater.json` (enable + cadence), and — only if the per-role cadence override
has not landed yet (see Cadence) — `src/types.ts`, `src/config.ts`, `src/orchestrator.ts`,
`src/loop.ts`; `test/qa-role.test.ts` (prompt contract: BUGS.md-only writes, time-limit and
ephemeral-port rules, the ordered flow list + vary rule + once-per-day real-run guard with its
Verified-note shape, constrained nested run — single enabled role, maxConcurrent 1, wall cap +
kill; plus the cadence-override tests if it lands here), README roles list.

## Acceptance criteria

- The qa role exists with the write restriction, safety rails, and one-flow scope in its prompt;
  tests assert the contract text.
- Flow selection works across fresh sessions: the prompt carries the ordered flow list (cheap
  first), the vary-across-ticks rule, and the once-per-day guard on real-mode runs; a qa tick
  that verifies the run flow in real mode appends its one-line `## Verified` note as an md-only
  diff, and cheap flows that pass declare nothing-to-do with no record. Tests assert the
  contract text; the daily cadence is verified by observation.
- Dogfood: a deliberately planted doc/behavior mismatch (e.g. a README flag that doesn't exist)
  is discovered and filed in BUGS.md within a few qa ticks — verified by observation.
- No qa tick ever leaves a listening process or an orphaned nested `tumwater run`/pi child
  behind (observable via the process table after its ticks); any real nested run is constrained to
  one enabled role and `maxConcurrent: 1`. `npm test` passes.

## Dependencies & sequencing

Last in the report's sequence: wants the watchdog (done) and ideally the review gate in place.
The per-role cadence override ([steward-role.md](steward-role.md)) is no longer a blocker — if it
has not landed, this change carries it (see Cadence). Riskiest item to run safely; the rails
above are the mitigation.

## Out of scope

Editing anything but BUGS.md; browser automation (curl-level checks only for now); performance
testing (perf role's territory); acting on its own filings.
