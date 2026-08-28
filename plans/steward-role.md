# Steward role — whole-system judgment on a slow clock

Planned 2026-08-24 · refined 2026-08-25 (cadence knob already exists globally; catalog
placement) · refined 2026-08-27 (QUESTIONS.md references made conditional — that file does not
exist until questions-outbox lands; read sites corrected to the actual four and resolution
decided via configForRole; backoff composition stated; dogfood needs no config edit)
· from the "Senior Tumwater" report (HN 49421554) · report item R5

## Goal

A low-frequency `steward` role that does no feature work: it re-reads the initial prompt,
PRINCIPLES.md, PLANS.md, BUGS.md (and QUESTIONS.md once it exists — see
[questions-outbox.md](questions-outbox.md)), and the shape of the codebase, then acts on the
deltas — pruning stale plans, merging duplicates, flagging drift from the initial prompt, and
keeping the complexity budget honest. It is the tech-lead layer that turns ten independent loops
into something resembling a team.

## Motivation

HN commenter **ben_w**: coding < development < engineering — the top layer is judgment nobody's
automating. **kypro**: someone must own complexity. **visarga**/**pianopatrick** report agent
projects disintegrating past tens of kLOC without exactly this oversight. Every current tumwater
role works bottom-up, one artifact at a time; the plan loop *adds* plans but nothing *curates*
them, and nothing compares the codebase to the project's reason for existing.

## Design

- **Role** (`src/roles.ts`): id `steward`, title "project steward", appended to the end of the
  `ROLES` array — after `improve`. The director is not a catalog entry (it is appended separately
  by `allRoleIds()`), so last-in-`ROLES` is exactly the lowest tie-break priority: it should never
  outrank shipping work. Find prompt,
  in spirit: "Re-read the initial prompt, PRINCIPLES.md, PLANS.md, BUGS.md — and QUESTIONS.md if
  it exists — and skim the codebase's shape (sizes, module list, test count). Then make ONE
  curation move, the
  most valuable one: delete or merge stale/duplicative/superseded PLANS.md entries (with a one-line
  epitaph in the entry's place or in Done); flag drift between what's being built and the initial
  prompt as a PLANS.md note or a question; tighten or update a principle or complexity budget in
  PRINCIPLES.md; or record a structural risk in BUGS.md. You edit only markdown — never source."
- **Write access**: explicitly allowed to edit PRINCIPLES.md (the exception alongside the
  director; see [principles.md](principles.md)) and to delete PLANS.md entries — the only role so
  empowered.
- **Slow cadence**: a *global* `minTickIntervalSeconds` already exists (`TumwaterConfig`,
  default 20 s) and is read at four sites (verified against main 2026-08-27): the min-gap check
  in `isEligible` (src/orchestrator.ts — this one also gates "main moved" early wakes, which is
  what keeps a slow clock slow) and three `nextRunAt` branches in `LoopRunner.tick()`
  (src/loop.ts: the `changed`, `skipped`, and cut-off-resume outcomes; the `aborted` branch
  schedules at once and the backoff branch uses `backoffSeconds`, so neither touches the
  interval). Add an optional **per-role** override to `RoleConfig` (`src/types.ts`; validated in
  src/config.ts by adding it to `ROLE_ENTRY_KEYS` plus a `checkNumber … >= 0`). Resolution is
  decided: extend `configForRole` — already the single place role overrides are applied over
  top-level values — with
  `minTickIntervalSeconds: rc.minTickIntervalSeconds ?? config.minTickIntervalSeconds`, and update
  its doc comment from "as seen by one role's pi runs" to "as seen by one role". Both read sites
  then call it (`LoopRunner.config` holds the *raw* config, so neither sees overrides unless it
  resolves): `isEligible` via `configForRole(runner.config, runner.role)`, and `tick()` resolves
  once at the top and uses that value in all three branches. Safe for existing consumers: the only
  other consumer (loop.ts's pi-run config) passes the result to `runPi`, which never reads the
  interval. Steward's default in `defaultConfig()`: per-role `minTickIntervalSeconds: 21600`
  (6 h) on its entry. Because runners get their config replaced on every live-reload poll, cadence
  edits apply within ~2 s like the other tick-interval settings. This override is generally useful
  — the same knob later serves the QA role. Backoff still applies on no-change ticks, capped as
  usual; note the composition: the per-role interval is a *floor* between consecutive ticks (after
  any landed work), while idle backoff grows separately on no-change ticks — so a steward whose
  normal state is "nothing to curate" settles at the backoff cap (10 h in this repo's config) and
  only the floor applies after it does land something. That is intended: slow clock, slower when
  idle.
- **Thinking budget / dogfood**: no tumwater.json edit is required to enable the role —
  `defaultConfig()` carries `{ enabled: true, minTickIntervalSeconds: 21600 }` for steward and
  `loadConfig` merges default entries for ids absent from the file, so this repo (whose config
  lists every other role explicitly but not steward) picks it up on the next live-reload poll and
  a new runner starts within ~2 s. An explicit `"steward": { … }` entry is optional: add one only
  to point it at the strong model with high thinking via the existing per-role overrides (or to
  make the fleet config self-documenting); defaults leave it inheriting.
- **Complexity budget**: the steward maintains a short "Budgets" section in PRINCIPLES.md (total
  LOC trend, module-size ceiling, dependency count = 0). Its prompt tells it to measure (`wc -l`,
  file counts) before adjusting — numbers from the repo, not vibes.
- **Md-only diffs** keep steward ticks review-exempt under
  [review-gate.md](review-gate.md)'s path rules.

## Files touched

`src/roles.ts`, `src/types.ts`, `src/config.ts` (RoleConfig field, ROLE_ENTRY_KEYS + validation,
`configForRole` fallback, defaultConfig steward entry), `src/orchestrator.ts` (`isEligible`
min-gap via configForRole) + `src/loop.ts` (resolve once in tick(); use in the changed/skipped/
cut-off-resume branches), `test/steward.test.ts` (role prompt contract — curation move list,
markdown-only restriction, deletion/PRINCIPLES powers, conditional QUESTIONS.md mention; interval
override honored in isEligible and all three tick() nextRunAt branches with global fallback when
unset; catalog order last), README roles list. `tumwater.json` only if the optional strong-model
entry is wanted (see Thinking budget / dogfood).

## Acceptance criteria

- The steward exists in the catalog (last position, lowest tie-break priority), is enabled by
  default for new inits *and* existing repos whose config lacks the entry (`loadConfig` merges
  defaults — no config edit needed), with a 6 h default cadence honored by the scheduler —
  unit-testable via `isEligible` and the tick() scheduling branches with a shortened override.
- Its prompt contains the curation move list, the markdown-only restriction, and the PLANS.md
  deletion/PRINCIPLES.md edit powers; prompt tests assert all three (plus the conditional
  QUESTIONS.md mention).
- Per-role `minTickIntervalSeconds` is validated config that works for any role, falls back to
  the global value when unset, applies live on tumwater.json edits (no restart), and gates "main
  moved" early wakes as well as scheduled ticks.
- Dogfood: within its first day enabled, the steward has made at least one curation commit
  (md-only) — verified by observation, not by test. `npm test` passes.

## Dependencies & sequencing

Wants [principles.md](principles.md) (done 2026-08-26); QUESTIONS.md references are conditional,
so [questions-outbox.md](questions-outbox.md) is no longer a prerequisite — the steward's
escalation channel simply appears when that file lands. Last of the markdown-layer items; before
the QA role (which reuses this plan's cadence knob).

## Out of scope

Reviewing individual diffs (the gate's job); editing source; scheduling or reprioritizing other
loops directly (its lever is the shared markdown, not the scheduler).
