# Feature: Per-role spending tracking and budget gates

## Summary

Upgrade cost accounting from a single fleet-wide number to **per-role** accounting, and
let operators control spend at the role level.

- **Tracking.** The existing usage/cost ledger keeps a per-role breakdown of
  per-tick token usage and estimated cost, aggregated by role id and reported in the
  same windows used today (day / all-time).
- **Surfaces.**
  - `tumwater report` prints a per-role table (ticks, tokens, cost) alongside the
    fleet totals; `--json` exposes the same rows as data.
  - `tumwater report --role <id>` scopes the whole report to one role.
  - Dashboard (GUI/TUI) shows a per-role cost breakdown view and/or per-role cost
    column where roles are already listed.
- **Budget gates (operator controls).**
  - A **daily per-role cap** (`maxDailyCostUsdPerRole`) — optional; a role that hits
    its cap pauses itself for the rest of the local day with a `role_paused` event
    citing the cap. The existing fleet-wide daily cap keeps working independently.
  - When only the fleet-wide cap is set, behavior is unchanged from today.
- **Enforcement points.** Caps are checked at tick start (cheap ledger read), so a
  role's in-flight tick finishes but no new tick starts past the cap.

## User experience

1. Operator sets `"maxDailyCostUsdPerRole": { "feature": 5, "organize": 1 }` in
   `tumwater.json` (absent keys = unlimited for that role, subject to fleet cap).
2. Mid-day, `tumwater report` shows `organize` at $1.02 — the dashboard shows it
   paused with a "daily cap reached" status.
3. Next morning the role resumes automatically; per-role counters start fresh.

## Rationale

- Roles have wildly different costs (e.g., a heavy planning loop vs. a light docs
  loop). A single fleet cap forces operators to starve cheap roles to protect budget
  from expensive ones; per-role caps let both coexist with predictable spend.
- Per-role visibility is the diagnostic half of the same problem: today, "where did
  my spend go" is answerable only by eyeballing tick logs.

## Constraints and notes

- Cost estimation uses the same model/pricing data as today; no new pricing source.
- Caps apply to the **local day** boundary, consistent with the existing daily cap.
- Pausing for a cap must be observable and reversible: it auto-clears at day
  rollover, and an explicit `tumwater resume --role <id>` also clears it early.
- Zero runtime dependencies; ledger stays in local project state (no external DB).
- Keep the config schema backward compatible: the new key is optional and fleet-wide
  behavior is byte-for-byte unchanged when it's absent.
