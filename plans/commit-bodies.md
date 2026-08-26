# Self-explaining commit bodies

Planned 2026-08-24 · refined 2026-08-25 (removed stale sibling note; turns-field coordination)
· from the "Senior Tumwater" report (HN 49421554) · report item R6a

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

- **Protocol** (`src/prompt.ts`): extend the reply contract in COMMON_RULES. After the existing
  `SUMMARY:` line, the run appends three short lines:
  `WHY:` (the motivation, one or two sentences), `RISK:` (what could break and where to look),
  `VERIFIED:` (what was actually run — "npm test, 182 pass" — never claims beyond what happened).
  New `extractCommitBody(finalText)` beside `extractSummary`, tolerant of any subset being absent.
- **Commit assembly** (`src/loop.ts`): `commitAll` message becomes
  `tumwater(<role>): <summary>\n\n<body>\n\n<trailer>` where the trailer is harness-stamped truth,
  not model claims: `Tick: <role> #<n> · turns <t> · ctx <peak>k`, plus the high-friction flag
  from [refusal-and-thrash.md](refusal-and-thrash.md) when set. Fallback when the run omitted the
  body: trailer only.
- **Turn/ctx counts**: `peakContextTokens` is already on `PiRunResult`; only the turn counter is
  new — a small `PiStreamParser` addition (count assistant `message_end` events, in the same hook
  that already reads usage) exposed as `PiRunResult.turns`. [refusal-and-thrash.md](refusal-and-thrash.md)
  needs the same field for thrash detection: whichever plan lands first adds it and the other
  reuses.
- **Consumers**: the review gate's prompt includes the body (claimed WHY/VERIFIED vs. actual diff
  is exactly the adversarial angle); `tumwater logs --role` transcripts and git history read
  properly today with no changes.

## Files touched

`src/prompt.ts`, `src/loop.ts`, `src/pi.ts`, `src/types.ts`, `test/commit-bodies.test.ts`
(extraction tolerant of partial blocks; assembled message shape; trailer stamped from harness
counters, not model text), README example.

## Acceptance criteria

- A fake-pi run emitting SUMMARY/WHY/RISK/VERIFIED produces a commit whose body carries all three
  lines plus the trailer; `git log` on a dogfood tick shows the structure.
- A run emitting only SUMMARY still commits, with trailer only.
- The trailer's turn/ctx numbers come from parsed stream counters (turns shared with the refusal
  plan's field). `npm test` passes.

## Dependencies & sequencing

None hard. Lands best before [review-gate.md](review-gate.md) so the reviewer can consume bodies
from day one.

## Out of scope

Enforcing body quality (reviewer's judgment); conventional-commits formatting; changelog
generation.
