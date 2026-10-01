# Implementation plan: Per-role spending tracking and budget gates

## Summary

Extend the existing usage ledger with a per-role dimension, thread it through the
report surfaces, then add an optional per-role daily cap enforced at tick start.
Three sequenced stages; each lands green independently.

## Stage 1 — Per-role ledger

1. In the usage/cost persistence layer, add a per-role rollup alongside existing
   totals: for each role id, accumulate `{ticks, inputTokens, outputTokens, costUsd}`
   per local day (reuse the existing day-bucketing and pricing helpers).
2. Keep fleet totals as the source of truth for existing behavior; per-role numbers
   are additive rollups derived at write time, not recomputed on read.

## Stage 2 — Surfaces

1. `report`: add a per-role section to the text report (sorted by cost desc) and
   `rows` under a `perRole` key for `--json`. Add `--role <id>` filtering that
   scopes all report sections to one role.
2. Dashboard: add per-role cost to the existing roles listing (GUI column and TUI
   row detail), fed by the same ledger read used by `report`.
3. CLI help text updated for the new flag.

## Stage 3 — Per-role daily cap

1. Config: optional `maxDailyCostUsdPerRole` map (role id → USD number) in
   `tumwater.json`; validated (positive numbers, known role ids warn on unknowns but
   don't crash — custom roles exist). Fleet-wide cap remains independent.
2. Enforcement at tick start: before a role's tick begins, read today's role total;
   if ≥ cap, pause that role with an existing pause mechanism, emitting a
   `role_paused` event whose message names the cap and today's spend.
3. Clearing: automatic at local-day rollover (the day bucket empties) and via
   explicit `resume --role <id>` (early clear; does not reset the ledger, just the
   pause).
4. Budget-pause events already flow to the notify hook; cap pauses should use the
   same event channel so operators hear about it once.

## Files touched (expected shape)

- Ledger/usage module: per-role rollup write path
- Report module: section + `--role` flag plumbing (CLI arg parsing → report data)
- Budget/budget-gates module: cap check at tick start
- Config schema + validation: new optional key
- GUI/TUI role rows: cost cell
- Tests: ledger rollup, report rows (text + json), cap trigger/pause/clear paths,
  schema validation, backward-compat (no new key ⇒ identical behavior)

## Test plan

- Unit: rollup math with multi-role, multi-day fixtures; cap boundary (at-cap, past-
  cap, resume-clears-pause); unknown role id validation.
- Integration-style: run a scripted day with two roles, one capped — capped role
  pauses at threshold, other continues, fleet cap untouched.
- Backward compat: existing config with only `maxDailyCostUsd` produces identical
  outputs to before.

## Risks and mitigations

- **Cost accounting drift** (per-role sums ≠ fleet total) → derive fleet totals from
  the same write path or assert equality in tests.
- **Double-pausing logic** (cap pause vs. breaker pause vs. operator pause) → reuse
  one pause mechanism with a reason field; last-pause-wins, resume clears all.
- **Day-boundary confusion** → same local-day semantics and rollover handling as the
  existing fleet cap; document in README settings section.

## Sequencing

Stage 1 alone delivers tracking value; Stage 2 makes it visible; Stage 3 adds
control. Stop after any stage and the feature is still coherent.
