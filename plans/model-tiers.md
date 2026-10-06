# Model tiers — small, default, and strong models, each with its own free fallback

Planned 2026-10-05 · requested by user

## Goal

Let an operator name up to three models by size — `small`, `default`, `strong` — plus a free
fallback for each, while a single-model setup stays one line of config. Tumwater assigns every
seam that runs pi (author ticks, the reviewer, the conflict resolver) a tier by default, and at
the daily cost cap each seam switches to the free model of **its own** tier instead of the whole
fleet collapsing onto one model.

## Motivation

- **One model does everything.** The live fleet (2026-10-05) runs all 14 roles and the reviewer
  on one model at one thinking level, so the reviewer judges work from its own model and shares
  its blind spots. The reviewer is also the seam where a model's quality matters most: every
  code change passes it, its misses land on main, and it holds the single landing slot the
  queue waits on.
- **The override plumbing exists but is costly to use.** A provider/model/thinking triple sits
  on the top level, on every `roles.<id>` entry, on `review`, and on `fallbackModel`, so "a
  strong model for the reviewer and the plan role" means repeating one triple in several places.
  And at the cap `applyFallbackModel` (src/config-views.ts) drops every override and puts every
  seam on one free pair — a strong paid reviewer degrades to the same free model as the
  cheapest author.
- **There is headroom for a stronger reviewer.** Measured from `.tumwater/log/events.jsonl`,
  2026-10-01 18:00 → 10-05: 703 ticks, 305 landings, $6.78 spent; reviews p50 17 s, p90 43 s
  (n=289); 58 rejections by the model reviewer. Review latency has room for a slower model and
  spend has room for a priced one.
- **Users arriving from oh-my-pi expect tiers.** omp's `PI_SMOL_MODEL` / `PI_SLOW_MODEL` /
  `PI_PLAN_MODEL` are per-session overrides of its `modelRoles` (omp.sh/docs/roles); pi 1.0.0,
  which tumwater runs, does not read them. This gives tumwater its own tiers, in tumwater.json.

## Design

### Config: `model` and `fallback`, each a string or a map by tier

One model — or leave `model` out entirely and pi's own default applies, as today:

```json
{ "model": "huggingface/zai-org/GLM-5.3-Flash:together:low" }
```

One model plus a free fallback:

```json
{
  "model": "huggingface/zai-org/GLM-5.3-Flash:together:low",
  "fallback": "omlx/Qwen3.8-27B-MLX-oQ4e-mtp"
}
```

Tiers — the same two keys become maps, listing only the tiers you have:

```json
{
  "model":    { "default": "huggingface/zai-org/GLM-5.3-Flash:together:low",
                "strong":  "huggingface/<strong-model>:high" },
  "fallback": { "default": "omlx/Qwen3.8-27B-MLX-oQ4e-mtp" }
}
```

Overriding one seam, with a tier name or a selector:

```json
"roles":  { "readme": { "model": "small" } },
"review": { "model": "default" }
```

- A string is shorthand for `{ "default": <string> }`.
- Map keys are exactly `small`, `default`, `strong`. A tier left out of `model` inherits
  `default`'s model (and a map with no `default` leaves the default tier on pi's own default). A
  tier left out of `fallback` borrows by the rule below.
- `thinking` (top-level, existing) stays: the level for any selector without a `:level` suffix,
  so `"thinking": "low"` keeps applying to the fallback exactly as it does today.
- Per-seam overrides are only `roles.<id>.model` and `review.model`. There is deliberately no
  key for the conflict resolver and no separate `tier` key.

### Selectors

A selector is `provider/id[:thinking]` — the form pi's own `--model` accepts. Tumwater parses it
itself, because pricing (src/pi/pi-models.ts) needs the provider and id apart, and keeps passing
`--provider` / `--model` / `--thinking` separately (src/pi/pi-args.ts):

1. A trailing `:x` is a thinking level only when `x` is in `THINKING_LEVELS`
   (src/config-schema.ts). `zai-org/GLM-5.3-Flash:together` keeps its `:together` (the HF
   router's provider pin); `…:together:low` is that model at thinking `low`.
2. The provider is the text before the first `/`, the id is the rest:
   `huggingface/zai-org/GLM-5.3-Flash:together` → provider `huggingface`, id
   `zai-org/GLM-5.3-Flash:together`. (Legacy configs with a `provider` key keep the old meaning —
   see Backward compatibility.)
3. A selector with no `/` is a bare model pattern for pi to resolve with no `--provider`, as a
   `model` without `provider` is today. It cannot be priced, so it never counts as free.
4. `small`, `default`, `strong` are tier references, valid only as the value of
   `roles.<id>.model` or `review.model`. `pause` is valid only as a `fallback` map value.

### Which tier each seam uses

| Seam | Tier | Code path |
| --- | --- | --- |
| Author ticks — feature, bugfix, organize, coverage, clean, dry, perf, qa, telemetry, improve, steward, director, user-defined loops | default | src/loop-pi.ts via `configForRole` |
| plan role | strong | same |
| readme role | small | same |
| Reviewer, plus its VERDICT and no-rerun follow-up turns | strong | src/review/review.ts, src/review/review-followup.ts via `reviewRunConfig` |
| Conflict resolver | strong | src/landing/landing-merge.ts `resolveConflict` (today: the authoring loop's own config) |
| SUMMARY follow-up, transient retry, resume-on-restart | the tick's own model | continuations stay on the session's model; switching would lose the prompt cache |

- Catalog roles carry their tier as a new `tier` field in src/roles/role-catalog.ts; user-defined loops
  are `default`.
- Why these: **strong** where an error costs the most and runs are rare or gate everything (the
  reviewer judges every code change; the plan role steers many feature ticks; the resolver edits
  code inside landing — on 2026-10-01 one "restored" code main had deliberately reverted, see
  BUGS.md's "A conflict resolution that changes the approved change's scope lands unreviewed").
  **small** only where the work is bounded and low-stakes — readme syncs
  the project brief from the commits since its last sync, and a docs error costs a later readme
  tick, not a broken main.
- With only one tier configured, every row resolves to the same model: behavior is identical to
  today.

### Budget fallback by tier

At the cap, each seam runs on its tier's resolved fallback:

1. The tier's **own** fallback, when it is declared, priced at zero in pi's `models.json`
   (`pairFree`), and its breaker is serving.
2. Otherwise another tier's **own** fallback (never one that tier itself borrowed), in order:

   | Tier | Tries |
   | --- | --- |
   | small | small → default → strong |
   | default | default → strong → small |
   | strong | strong → default → **pause** (never small) |

3. Otherwise — or when the tier's fallback is `"pause"` — the tier pauses.

Borrowing upward costs only speed, since the model is free. Borrowing one step down keeps the
fleet working. The strong tier never drops to a small model, because a weak reviewer or planner
does more harm than a paused one.

The fleet-level gate (`budgetGate`, src/budget/budget.ts) stays three-valued:

- `open` — under the cap.
- `paused` — the default tier pauses (no usable fallback anywhere), or review is on and the
  strong tier pauses (nothing could land).
- `fallback` — otherwise. A role whose own tier paused (possible only for strong-tier roles with
  review off, i.e. plan) is held individually, and its row reads `budget paused`.

Unchanged: the director keeps its paid model; in-flight ticks finish on the model they started
on; `budget_handback` hands running ticks back when the gate reopens; the reviewer's
`FALLBACK_REVIEW_TIMEOUT_S` floor applies while it runs on a fallback; and a raw per-seam override
(a selector, not a tier name) is dropped at the cap, so the seam falls back through its built-in
tier and a paid pin cannot keep spending.

The fallback breaker (src/budget/fallback-breaker.ts) is one `FallbackBreaker` keyed by the pair's name
today; it becomes a map keyed by pair, so tiers sharing a fallback share a breaker and a demoted
pair re-resolves only the tiers that use it.

This keeps today's behavior exactly: a single `fallbackModel` F reads as `fallback: { default: F
}`, the small tier borrows up to F, the strong tier borrows down to F, and every seam lands on F.

### Backward compatibility

- **Legacy top-level `provider`.** When present, a string `model` is a bare id under that
  provider (the old meaning), so `"provider": "huggingface", "model":
  "zai-org/GLM-5.3-Flash:together"` does not parse as provider `zai-org`. Combined with the map
  form of `model` it is a validation error.
- **Legacy `fallbackModel`.** The object reads as `fallback: { default: <pair> }`. Setting both
  `fallback` and `fallbackModel` is a validation error naming both keys.
- **Legacy `provider` / `thinking` on `roles.<id>` and `review`** keep their meaning, applied over
  the seam's resolved model — so a thinking-only override such as `review.thinking: "high"` still
  works.
- **Writers emit only the new form:** `tumwater init` templates (src/init/init-templates.ts),
  `tumwater config set` (a dotted `model.strong` merges one map entry, the way `roles.qa.model`
  already does), and the GUI's config edits (`EDITABLE_CONFIG_KEYS`). Nothing rewrites an
  existing tumwater.json.

### Observability

- `tick_start` and `review_start`, plus the conflict resolver's run, record the model actually
  used (`model: "provider/id:thinking"`). Today they carry only the tick number or head, so no
  model choice can be evaluated from the event log.
- Role rows (src/roles/role-view.ts, src/status/status-data.ts, both dashboards) show each role's tier and
  resolved model.
- `budget_fallback` carries the per-tier resolution, e.g. `tiers: { default:
  "omlx/Qwen3.8-27B-MLX-oQ4e-mtp", strong: "omlx/Qwen3.8-27B-MLX-oQ4e-mtp (from default)" }`,
  alongside its existing `provider` / `model` fields (the default tier's), so current readers
  keep working.
- `fleetModelsFree` (src/pi/pi-models.ts) covers every resolved seam: each enabled role's tier
  model, plus the strong model for the reviewer and the resolver.

### Doctor

- Every declared model and fallback resolves in pi's catalog, and its provider has credentials
  (`pi auth check --provider <p> --json` reports `ready`); every fallback is priced at zero. A
  strong tier on a provider without credentials would fail every review, and so every landing.
- When `PI_SMOL_MODEL`, `PI_SLOW_MODEL`, or `PI_PLAN_MODEL` is set, say that tumwater does not
  read them: they are omp's, pi ignores them, and with omp as `agentBin` they still reach omp
  because pi runs inherit the environment (src/pi/pi.ts). Point at `model.small` /
  `model.strong`.

### Fleet hold per provider

src/fleet/fleet-hold.ts trips one fleet-wide hold when two roles fail the same way within two minutes;
it assumes a single backend. With seams on different providers, a 429 storm at the reviewer's
provider would stop authors on a healthy one. Key storms by provider as well as kind, and hold
only the roles whose tick model is on the failing provider. A hold on the strong tier's provider
while review is on still holds the fleet, because nothing could land.

### Notes for local fallbacks

- Distinct local fallbacks on one server must all fit in memory at once, or the server swaps
  models per request. For example, a 103 GB GLM-5.3-Flash oQ2 plus a 16 GB Qwen3.8-27B exceed a
  128 GB Mac's ~107.5 GB GPU working-set cap. Usually: declare only `fallback.default` and let
  the strong tier borrow it, or reuse the same local model at a higher thinking level.
- "Same model, more thinking" needs the level to reach the server. oMLX's Qwen ignores
  `reasoning_effort` and honors only `thinking_budget`, which pi sends only when the model's
  `models.json` entry sets `compat.thinkingTokenBudgetField: "thinking_budget"`; without it,
  `:high` on that model is a no-op.

## Phases

Each lands and is useful on its own:

1. **Selectors.** Parser, the string form of `model` / `fallback`, the legacy keys, the writers,
   and `model` on `tick_start` / `review_start`. One tier only; no behavior change.
2. **Tiers.** Map form, the catalog `tier` field, the reviewer and resolver on strong, tier
   references in `roles.<id>.model` / `review.model`, `fleetModelsFree`, display.
3. **Tiered fallback.** Per-tier resolution in the budget gate, the breaker map, events, badge.
4. **Per-provider fleet hold, doctor checks.**
5. **Docs.**

## Files touched

src/config-schema.ts (types, key lists), src/config-validation.ts and src/config-field-checks.ts
(shapes, legacy conflicts), src/config.ts (defaults, overlay of string-or-map), a new
src/config/model-selector.ts (parse and format), src/config-views.ts (`configForRole`, `reviewConfig`,
`fallbackPair`, `applyFallbackModel` by tier, plus a resolver view), src/roles/role-catalog.ts (`tier`),
src/pi/pi-models.ts (`fallbackModelFree` per tier, `fleetModelsFree`), src/budget/budget.ts,
src/gates/budget-gates.ts, src/budget/fallback-breaker.ts, src/landing/landing-merge.ts and
src/landing/landing-core.ts (resolver on strong), src/review/review.ts, src/review/review-followup.ts,
src/loop.ts (`tick_start` model), src/events/events.ts, src/events/event-format.ts, src/fleet/fleet-hold.ts,
src/fleet/fleet-polls.ts, src/doctor/doctor-checks.ts, src/roles/role-view.ts, src/status/status-data.ts, src/ui/*,
src/config-editable-keys.ts, src/config-write.ts, src/init/init-templates.ts, src/config-example.ts,
README.md, docs/backends.md, docs/how-it-works.md, docs/feature-model-fallback.md,
docs/implementation-model-fallback.md, and their tests.

## Acceptance criteria

- `{ "model": "<provider>/<id>" }` alone is a complete config; its pi runs carry `--provider` and
  `--model` from it (pinned with the fake pi shim).
- A selector's trailing `:level` becomes `--thinking` only for a real level;
  `zai-org/GLM-5.3-Flash:together` passes through intact.
- Every existing config — legacy `provider` / `model` / `thinking`, per-role and review triples,
  `fallbackModel` — produces the same pi argv as before; mixing a legacy key with its new form is
  a validation error naming both.
- With only `default` declared, every seam's argv and the budget gate's behavior are unchanged
  (the existing tests pass untouched).
- With `strong` declared, the reviewer, plan, and conflict-resolver runs carry the strong model;
  readme carries `small` when declared, else `default`.
- At the cap, each seam runs on its tier's fallback; a tier without one borrows in the stated
  order; strong never borrows from small; with review on and no fallback reachable by strong, the
  gate is `budget_paused`.
- `tick_start` and `review_start` carry the model used; `budget_fallback` carries the per-tier
  resolution.
- `doctor` flags a tier model that does not resolve or lacks credentials, a priced fallback, and
  set `PI_*_MODEL` variables.
- A 429 storm on one provider does not hold roles running on another.

## Out of scope

- Reading `PI_SMOL_MODEL` / `PI_SLOW_MODEL` / `PI_PLAN_MODEL` as config: they are omp's
  per-session overrides, pi ignores them, and the environment is invisible to tumwater.json's
  live reload and differs between shells and launchers.
- Routing inside a pi run (pi 1.0 virtual models): every switch loses the prompt cache and splits
  a tick's cost across models, and tumwater's ticks are already short and start fresh.
- Guessing which of a user's models is stronger; more than three tiers or user-named tiers;
  per-role fallbacks; fallback triggers other than spend; moving the director onto a fallback;
  raising thinking automatically for a borrowed fallback.
- Choosing which models the live fleet should use. That is an operator decision, best A/B'd
  offline before switching, once phase 1 records the model on each event.
