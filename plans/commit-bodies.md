# Self-explaining commit bodies

Planned 2026-08-24 · refined 2026-08-25 (removed stale sibling note; turns-field coordination)
· refined 2026-08-27 (trailer number sources, exact format + helper placement, body length caps,
VERIFIED honesty rule, single assembly site shared with the refusal plan) · from the "Senior
Tumwater" report (HN 49421554) · report item R6a

## Goal

Every tick's commit carries a structured body — what changed, why, the risk, and how it was
verified — written by the authoring pi run and grounded in the diff, plus a harness-stamped
trailer with tick metadata. The subject line stays the existing 72-char summary.

## Motivation

HN commenter **TonyAlicea10** built "do-i-understand": force an explanation of the code, grounded
in specific lines, before submission — the explanation is the comprehension check. For an agent
fleet the commit body is that explanation: it gives the review gate, the steward, and the human a
paper trail of claimed understanding to check against.

## Design

- **Protocol** (`src/prompt.ts`): extend `SUMMARY_RULE` — the single constant both tick/director
  prompts (via COMMON_RULES) and the resume bridge share; extending it there keeps all three from
  drifting. After the existing `SUMMARY:` line, a run that made changes appends three short lines:
  `WHY:` (the motivation, one or two sentences), `RISK:` (what could break and where to look),
  `VERIFIED:` (what was actually run and observed — "npm test, 182 pass" — never claims beyond
  what happened; when nothing was run, write `none` rather than omitting). New
  `extractCommitBody(finalText)` beside `extractSummary`: one anchored regex per field
  (`/^\s*WHY:\s*(.+)\s*$/m`, etc.), tolerant of any subset being absent (a non-compliant reply
  still commits), and **capped at 200 chars per field** (truncate + ellipsis) so a verbose model
  cannot bloat every commit. `SUMMARY` itself is untouched — existing contract, no new
  enforcement.
- **Commit assembly** (`src/loop.ts`): the changed-tick path builds
  `tumwater(<role>): <summary>\n\n<body>\n\n<trailer>` where `<body>` is the three lines joined by
  newlines (omitted entirely when none were extracted) and the trailer is harness-stamped truth,
  not model claims. Fallback when the run omitted the body: subject + trailer only. **Single
  assembly site:** keep this in one small helper so that when
  [refusal-and-thrash.md](refusal-and-thrash.md) lands, its refusal commit
  (`tumwater(<role>): refuse — <reason>`) routes through it too — a sentinel reply carries no body
  lines, so refusals naturally get subject + trailer only. Whichever of the two plans lands second
  moves both paths onto the shared helper; there is exactly one place that builds a tick commit
  message.
- **Trailer format (decided):** one line — `Tick: <role> #<tick> · turns <t> · ctx <c>` where
  `<tick>` is `s.ticks` and `<c>` uses the status table's compact style (`12k` at ≥10,000, bare
  integer below). Built by a pure helper (e.g. `commitTrailer(role, tick, turns, peakCtx)`) in
  src/prompt.ts beside the extractors — unit-tested there, formatting kept out of the tick
  lifecycle. The high-friction flag from [refusal-and-thrash.md](refusal-and-thrash.md) appends to
  this line when set (that plan owns the flag; this one reserves the slot).
- **Trailer number sources (decided):** a tick can fold several pi runs before its commit — the
  main run plus, on a transient model-server timeout, one resumed retry. Both already land in
  `foldUsage` (src/loop.ts), the single place every pre-commit run's usage is folded into the
  per-tick windows:
  - `turns`: add a **non-persisted** counter to LoopRunner (e.g. `tickTurns`), reset at tick start
    alongside `generatedTokens`/`peakContextTokens`, incremented in `foldUsage` by `run.turns`. At
    commit time it holds exactly the pre-commit runs' total. Conflict-resolution runs fold *after*
    `commitAll` (they happen inside `merge`) and are naturally excluded — correct: the trailer
    describes the authoring run(s), not the merge repair. Deliberately not added to LoopState: its
    only consumer is the trailer stamped into the commit message itself, which is durable; no
    state-schema change.
  - `ctx`: read `s.peakContextTokens` at commit time — already the max across this tick's
    pre-commit runs by the existing per-tick-window logic (see BUGS.md "gen / peak ctx columns").
- **Turn counter** (`src/pi.ts`): a small `PiStreamParser` addition — count assistant
  `message_end` events in the same hook that already reads usage (`this.outputTokens += …`) —
  exposed as `PiRunResult.turns`. Adding the field touches the parser plus the single
  `resultFromParser(overrides)` builder in runPi (the unified PiRunResult construction added by a
  recent dry pass — its comment says adding a field touches that one place).
  [refusal-and-thrash.md](refusal-and-thrash.md) needs the same field for thrash detection:
  whichever plan lands first adds it and the other reuses. Do not reuse `progress.ts`'s live
  counters: those describe the log tail for dashboards, not a finished run's totals.
- **Consumers**: the review gate's prompt includes the body (claimed WHY/VERIFIED vs. actual diff
  is exactly the adversarial angle); `tumwater logs --role` transcripts and git history read
  properly today with no changes.

## Files touched

`src/prompt.ts` (SUMMARY_RULE extension, extractCommitBody + commitTrailer), `src/pi.ts` (parser
turn counter; PiRunResult.turns via the single builder), `src/loop.ts` (tickTurns reset in tick()
+ increment in foldUsage; assembly at the changed-tick site), `src/types.ts` (PiRunResult.turns),
`test/commit-bodies.test.ts` (extraction tolerant of partial blocks + 200-char caps; trailer
format from harness counters, not model text; assembled message shape with and without body; turn
counter over a multi-run tick — main + transient retry folds both, conflict run excluded), README
example.

## Acceptance criteria

- A fake-pi run emitting SUMMARY/WHY/RISK/VERIFIED produces a commit whose body carries all three
  lines plus the trailer `Tick: <role> #<n> · turns <t> · ctx <c>`; `git log` on a dogfood tick
  shows the structure.
- A run emitting only SUMMARY still commits, with subject + trailer only.
- The trailer's turn/ctx numbers come from parsed stream counters (turns shared with the refusal
  plan's field): a tick whose main run is retried after a transient server timeout reports the sum
  of both runs' turns; conflict-resolution runs do not inflate it. `npm test` passes.

## Dependencies & sequencing

None hard. Lands best before [review-gate.md](review-gate.md) so the reviewer can consume bodies
from day one. Shares exactly one field (`PiRunResult.turns`) with
[refusal-and-thrash.md](refusal-and-thrash.md); either order works — the later plan reuses it and
routes its refusal commit through this plan's assembly helper.

## Out of scope

Enforcing body quality (reviewer's judgment); conventional-commits formatting; changelog
generation; SUMMARY length enforcement (existing behavior).
