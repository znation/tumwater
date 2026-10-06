# Implementation plan: Model fallback on repeated backend failures

## Summary

Add per-role fallback state machine (primary → fallback → probe → primary), an
optional `fallback` config (the legacy `fallbackModel` object still parses), event
emissions, and dashboard/CLI visibility.
The state machine lives in its own module; the loop consults it at tick start and
records outcomes at tick end.

## Work breakdown

### Stage 1 — Fallback state machine (pure logic)

1. New module `model-fallback` owning per-role state:
   - `recordFailure(role, failureClass)` / `recordSuccess(role)`
   - Trip rule: N consecutive `provider-level` failures (reuse the existing
     transient/backend-kind classifier so definitions never drift) →
     state = `fallback`.
   - While in `fallback`: success of a fallback tick does NOT return the role to
     primary; only a successful canary probe does.
   - Probe scheduler: `probeDue(role, now)` with a modest interval (e.g., every
     10 min), jittered; `recordProbeResult(role, ok)` — after `confirmCount`
     consecutive successful probes (default 1), state returns to `primary`.
   - Pure and clock-injectable, matching house patterns (no `Date.now()` reads
     buried inside).

### Stage 2 — Wiring

1. Config: optional `fallback` — a selector string or a per-tier map, with the legacy
   `fallbackModel {provider, model}` object still parsed; absence disables the feature
   (state machine never trips).
2. Tick start: loop asks the state machine for the effective model
   (`fallback ? fallbackModel : primaryModel`) and passes it to the pi invocation.
3. Tick end: feed the failure classifier's verdict into
   `recordFailure/recordSuccess`.
4. Canary probe: on `probeDue`, run a minimal model call (tiny prompt, low max
   tokens) through the existing invocation path; a completed call = success, a
   provider-class failure = failure probe. Content of the reply is irrelevant.
5. Events: emit `model_fallback_started` (with tripping reason) and
   `model_fallback_ended` (with episode duration) — these flow into the existing
   feed, so dashboards, history, and the failure digest pick them up without new
   plumbing.

### Stage 3 — Surfaces

1. `tumwater role <id>` output gains effective-model info ("on fallback since …").
2. GUI/TUI role rows show a fallback badge while active.
3. `tumwater report --json` optionally tags fallback-window ticks (by joining event
   timestamps) so cost analysis can separate them.

## Test plan

- Unit tests for the state machine: trip threshold boundary (N-1 vs N), probe
  scheduling, confirm-count return, content-failures-never-trip rule, disabled-when-
  unconfigured.
- Integration-style: scripted loop where primary fails 3× → ticks run on fallback →
  probe succeeds → next tick runs on primary; assert events emitted in order.
- Cost ledger: fallback tick is attributed to the role normally.

## Risks and mitigations

- **Flapping** (primary half-broken) → confirm-count and probe interval make return
  conservative; only providers-class failures trip, so partial failures that still
  complete ticks never trip at all.
- **Canary cost** → tiny token ceiling, infrequent interval; negligible next to ticks.
- **Fallback model quality drop** → badge on dashboards keeps it visible; feature is
  opt-in via config; documented that fallback sees the same prompts.
- **Interaction with error-streak breaker** → failures on fallback still count
  toward streaks (they're real failures); document that fallback reduces but does
  not eliminate breaker trips.

## Sequencing

Stage 1 is a pure module landing green with no behavior change. Stage 2 activates
the feature behind config. Stage 3 is pure observability.
