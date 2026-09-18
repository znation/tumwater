# Fallback model — keep working for free once the budget is spent

Planned 2026-09-18 · requested by user · implemented 2026-09-18

## Goal

When the fleet's spend for the local day reaches `maxDailyCostUsd`, role loops stop until the
next local midnight (plans/daily-cost-budget.md). Give the operator a second option: name a
**cost n/a** model — one pi's `models.json` prices at zero — as `fallbackModel`, and the gate
switches the role loops onto it instead of stopping them. The budgeted model does the day's
paid work; the free model keeps the fleet alive afterwards. Spend cannot advance on a
zero-priced model, so the cap still holds — the day's paid spend simply stops climbing.

## Motivation

The cap is the right guardrail but the wrong ending. A fleet with a local model server sitting
idle next to it has no reason to stop working when the API budget runs out: the work just gets
cheaper and slower. Before this, the only way to keep going was to raise the cap — which is
exactly the wrong lever, because it gives up the guarantee the cap exists to provide. The
fallback separates the two questions the pause was conflating: *how much money may the fleet
spend today* (still `maxDailyCostUsd`) and *must it stop when the money is gone* (now: only if
there is nothing free to fall back to).

This is the harness's existing "(cost n/a)" notion — `src/pi-models.ts` already reads pi's
model definitions to decide whether a fleet's models are priced, and the dashboards already
read `· budget: n/a` for an all-free fleet — pointed at a second job: not just *describing* a
free fleet, but *becoming* one when the paid budget runs out.

## Design

### Config: `fallbackModel` (top-level, optional)

```json
"fallbackModel": { "provider": "omlx", "model": "Qwen3.8-27B-MLX-oQ4e-mtp" }
```

- `provider` / `model` / `thinking`, each falling back to the top-level value — the same
  precedence as a role's and the reviewer's overrides, so naming only `model` keeps the current
  provider. Validated for shape (`FALLBACK_MODEL_KEYS`, string fields, at least one of
  provider/model), and an empty object is rejected: it names nothing, so it would silently
  never engage.
- **Absent by default.** Nothing in `defaultConfig()`: the harness cannot know which model on
  a given machine is free, and a wrong guess would either never engage or engage something
  paid. With no fallback configured, the gate behaves exactly as it did before.

### The gate is three-valued

`BudgetGate = "open" | "fallback" | "paused"` (src/state.ts), from one pure function over two
inputs — has spend reached the cap, and is a cost-free fallback ready:

| spend < cap | fallback usable | gate | role loops |
| --- | --- | --- | --- |
| yes | — | `open` | tick on the budgeted model |
| no | yes | `fallback` | tick on the free model |
| no | no | `paused` | start no new ticks (today's behavior) |

"Reached the cap" and "the loops are stopped" stopped being the same fact, so the boolean had
to become an enum. Only `paused` blocks a tick. The director is outside all of it — it keeps
the budgeted model and keeps ticking, because an explicit human prompt outranks the
autonomous-spend cap (the same exemption the pause already had).

### "Usable" means verified free, not merely configured

`fallbackModelFree(config, modelsPath)` (src/pi-models.ts) resolves the pair and asks pi's
`models.json` whether it is priced at zero, through the same `pairFree` helper `fleetModelsFree`
now shares. Anything unresolvable — a half-named pair that would fall through to pi's own
default, an unknown provider or model id, a missing or malformed definitions file, a priced
model — counts as NOT free, and the gate pauses as before, naming the refused pair in the
`budget_paused` event. A fallback that can spend would defeat the very cap it exists to
survive, and "I could not check" is not "it is free".

### Switching is a config swap, not a new plumbing path

`applyFallbackModel(config)` (src/config.ts) returns the config role loops run under while the
gate holds: the fallback pair installed as the top-level `provider`/`model`/`thinking`, **and
every per-role and reviewer model override dropped**. Dropping the overrides is the point — a
role pinned to a paid model in `tumwater.json`, or a strong paid reviewer, must not keep
spending after the cap is reached. Everything else (intervals, thresholds, exempt paths, the
cap itself) is untouched, so the gate keeps re-evaluating against the same numbers.

The orchestrator pushes that derived config into every non-director runner each poll (not only
on transitions, so a runner created mid-gate cannot tick on the wrong model), and a landing
runs under its **authoring loop's own** config — under the fallback, a budgeted reviewer would
spend past the cap. That one assignment makes every existing seam — author run, SUMMARY
follow-up, reviewer, conflict resolver — resolve to the free pair with no further plumbing.

Resume stays live and stateless: crossing local midnight, raising the cap, or fixing a mistyped
fallback id re-evaluates the gate on the next ~2 s poll. `models.json` is stat-cached inside
pi-models.ts, so the added freeness check costs one stat per poll.

### Events and display

- `budget_fallback` joins `budget_paused`/`budget_resumed`, one event per transition between
  any two gate states, harness-level with `spentUsd`/`capUsd`. Entering `fallback` carries the
  pair that took over; entering `paused` with a fallback configured carries `fallbackRejected`
  — the reason the fleet stopped instead of switching is the one thing an operator can act on.
- Header badge (both dashboards, one preformatted string): `· budget: $10.02/$10 today ·
  fallback: <model> (cost n/a)` while the fallback carries the fleet, byte-identical to before
  otherwise.
- State cells: only `paused` reads `budget paused`. Under `fallback` the loops are working, so
  their rows read their normal state.

## Files touched

src/types.ts (FallbackModelConfig, config field, `budget_fallback`), src/config-validation.ts
(key list + shape), src/config.ts (`fallbackPair`, `applyFallbackModel`, clone/merge),
src/pi-models.ts (`pairFree`, `fallbackModelFree`), src/state.ts (`BudgetGate`, `budgetGate`),
src/orchestrator.ts (gate, transition events, config push, landing config, `modelsPath` seam),
src/ui/status.ts (snapshot `budget.fallback`), src/ui/status-render.ts (badge, state cells),
src/ui/status-payload.ts, src/ui/event-format.ts, README.md, and their tests.

## Acceptance criteria

- `fallbackModel` is a validated optional top-level key; absent, the budget gate pauses role
  loops exactly as before (every existing budget test unchanged).
- With a zero-priced fallback configured, a fleet at its cap keeps ticking, and its pi runs
  carry the fallback `--provider`/`--model` — pinned end-to-end with the fake pi shim.
- A configured fallback that pi's definitions do not price at zero (unknown id, priced model,
  missing file) never engages: the fleet pauses and the event names the refused pair.
- Per-role and reviewer model overrides do not survive the switch.
- One event per gate transition; both dashboards name the fallback in the header badge while it
  carries the fleet, and idle rows read `budget paused` only under `paused`.

## Out of scope

Chains of more than one fallback; a paid-but-cheaper fallback (the cap could then still be
exceeded — raise the cap instead); falling back on anything other than spend (rate limits,
provider outages); moving the director onto the fallback.
