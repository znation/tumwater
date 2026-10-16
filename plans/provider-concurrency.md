# Provider concurrency — per-provider caps, and claude + pi in one fleet

Planned 2026-10-15 · requested by user · audited against main `a2131b5a`

## Goal

Two operator asks, one plan.

**1. Per-provider concurrency caps.** `tumwater.json` can cap how many runs each model provider
serves at once, beside the fleet-wide `maxConcurrent`:

```jsonc
{
  "maxConcurrent": 8,              // the whole fleet, as today
  "maxConcurrentPerProvider": {
    "omlx": 3,                     // the local server's slots, minus one for the director
    "claude": 6
  }
}
```

- A tick, a landing vet, or a conflict resolver starts when **both** its provider and the fleet
  have headroom.
- Providers never wait on each other. A full `omlx` does not hold back a `claude` or
  `huggingface` run while fleet slots are free.
- A provider with no entry is bounded by `maxConcurrent` alone. A config without the key
  behaves exactly as today.

The operator can then raise the total, knowing the local server (or any one provider) never
gets more streams than its own cap.

**2. Mixed backends, verified.** Seams may span providers: Claude for the strong tier and Hugging
Face or oMLX for the rest, or the reverse. That fleet must work, and each run must spawn the right
CLI on its own: `claude` for Claude models, `pi` for every other provider, at the same time.

The per-seam routing exists (plans/agent-backends.md §3), but nobody has run a mixed fleet. This
plan does four things about that:

- audits the routing and closes the gaps found (§9);
- adds an orchestrator-level test that runs both fakes in one fleet;
- makes a bare Claude model id route to `claude` without needing `agent` or a `claude/` prefix;
- ends with a bounded live smoke run.

## Why `maxConcurrent` alone is not enough

- **One semaphore bounds all model work** (src/orchestrator/orchestrator.ts).
  - A role tick holds a permit for its whole length: author run, check, review gate.
  - Each landing vet holds one for the vet's length.
  - The merge's conflict resolver takes one for its run (landings count since BUGS.md
    2026-09-18).
  - Only the director runs outside it.
- **So `maxConcurrent` must be safe for the weakest provider any seam can reach.** On a local
  server that is its slot count. One client too many and the prefix caches thrash, until the
  quiet watchdog kills starved ticks (docs/backends.md "Match clients to slots").
- **A cloud provider beside it could take far more.** Claude or HF Inference Providers could run
  many more streams, but one fleet-wide number cannot say "3 on oMLX, 6 more on claude".
- **The budget fallback makes it worse.** At the daily cap every priced seam moves to its
  fallback, which is oMLX today. `maxConcurrent` therefore already has to be safe for an all-local
  fleet, even on days the fleet runs mostly in the cloud.

## Design

### 1. Config: `maxConcurrentPerProvider`

- A map from provider key (§2) to a positive integer. It is optional and absent by default, like
  `maxDailyCostUsdPerRole`. The `…PerX` name follows that key and `quietHoursPerRole`.
- `maxConcurrent` keeps its meaning: the fleet total over role ticks, vets and resolvers.
- An entry at or above `maxConcurrent` is legal but inert. Doctor notes it (§8).
- **Validation** (src/config/config-validation.ts): the value must be an object, and each value a
  positive integer under a non-empty key.
  - An unknown provider name is **not** a validation error. Providers live in pi's
    `models.json`, which validation does not read, and a fallback's provider may only come into
    use later. Doctor warns instead.
- **Writers.**
  - `tumwater config set maxConcurrentPerProvider.omlx 3` merges one entry.
  - `config unset maxConcurrentPerProvider.omlx` removes it.
  - `DOTTED_MAP_KEYS` (src/config/config-write.ts) is per-role today: the map's keys are checked
    against the role catalog. This map's keys are provider names, so the dotted-key parser needs
    a branch that skips the role check.
- **Docs:** tumwater.example.json, docs/config.md, and the editable-keys list.

### 2. The provider key

The key is the one the fleet hold already files under, `seamHoldKey`
(src/config/config-views.ts):

- a non-pi backend's own agent id (`claude`);
- otherwise the pi provider (`omlx`, `huggingface`, `lm-studio`).

One addition: a pi seam that names no model at all runs pi's saved default, so it takes the
`defaultProvider` from pi's `settings.json`. tumwater already reads it through `readPiDefaultModel`
(src/pi/pi-settings.ts), the same reader that labels "pi's own default" loop rows. With that,
`omlx: 3` caps a fleet that leaves the model to pi.

A seam left without a key has only the total to bound it, and doctor says so (§8). That happens in
two cases:

- a bare model id with no provider, which pi resolves across all its providers;
- a seam whose pi settings cannot name a default.

- **New helper:** `seamConcurrencyKey(cfg, piDefault)` sits in config-views.ts next to
  `seamHoldKey` and returns `seamHoldKey(cfg)`. For a pi seam with no model it falls back to
  `piDefault?.provider`. The caller passes the cached `readPiDefaultModel` result, so the config
  layer stays free of I/O.
- **HF sub-provider pins share one key:** `huggingface/…:deepinfra` and `huggingface/…:together`
  are both `huggingface`.
- **Billing does not split the key:** subscription and API-key claude are both `claude`.
- **Why reuse the hold key:** "omlx is held" and "omlx is full" then name the same thing on every
  surface.

### 3. A keyed permit pool

Generalize `Semaphore` (src/concurrency/semaphore.ts). Do not put a second semaphore beside it:
two semaphores acquired one after the other either hold a fleet permit while waiting for a
provider permit, or the reverse. The first way blocks every other provider, which is the
head-of-line problem this plan exists to remove. Admission has to test both at once.

- **`acquireLease(tier, key?)`** returns a lease handle `{ key, release(), rekey(to) }`. The
  existing keyless `acquire(tier)`/`tryAcquire()`/`release()` stay as they are, so check-permit.ts
  and other callers that never key do not change. `forceLease(key)` returns a lease at once (the
  director, §4). `acquireLease` grants when both hold:
  - fleet: `inUse < capacity − reserveFor(tier)`;
  - provider: `keyInUse(key) < keyCap(key)`. A key with no cap (or no key) passes this test
    always.
- **One wait queue, ordered by tier then FIFO, as today.** The hand-off scans the queue in order
  and grants every waiter whose key and the fleet both have headroom.
  - A waiter whose key is full is skipped and keeps its place.
  - So FIFO holds within a provider, and a later waiter for another provider is never stuck
    behind it.
  - The reserve still stops the scan at the first tier ≥ 1 waiter it withholds from. The queue
    is tier-ascending, so everything behind that waiter is withheld too.
- **Resizing.** `setCapacity` and `setReserve` keep their never-preempt semantics, and the new
  `setKeyCaps(caps)` behaves the same way for the map: shrinking stops future grants until
  releases drain in-use under the new cap.
- **No keys, no change.** `withCheckPermit`'s semaphore and a fleet without the map behave
  exactly as today, because every waiter's key is uncapped and the scan grants the head.
- **`snapshot()`** returns
  `{ inUse, limit, reserve, byKey: { [key]: { inUse, limit?, waiting } } }` for observability
  (§8).

### 4. Who holds a lease, and on which key

| Holder | Queue tier | Key at acquire | Held for |
| --- | --- | --- | --- |
| Role tick | `roleTier` (0 work, 1 maintenance) | `seamConcurrencyKey(runner.runConfig(now), piDefault)`: the authoring seam, with any budget or model-failure fallback already applied. `LoopRunner.runProvider` does the same for the hold today | the tick |
| Landing vet | `LANDING_TIER` | the review seam's key for the author's role (`reviewRunConfig`); none when review is off, since such a vet runs no model | the vet |
| Conflict resolver | `MERGE_TIER` | `resolverConfig`'s key | its run |
| Director | never queues | its run's key | its runs |

**The director keeps its bypass.** It never waits, and it still does not count toward
`maxConcurrent`. It **does** count toward its provider's in-use: a forced acquire raises the count
without waiting. So while a director run is on `omlx`, one fewer role tick starts there.

- In-use can sit one above the cap while the director runs, if it arrived at a full provider. No
  grant on that key happens until releases bring it back under the cap.
- The overshoot then lasts until the first role run on that provider releases, not for the whole
  director session.
- docs/backends.md's rule (server slots ≥ cap + 1 when the director shares the provider) carries
  over unchanged from `maxConcurrent`.

### 5. Leases follow the tick's runs (re-keying)

One tick's runs do not always share a provider:

- the reviewer runs on the strong tier, often a different provider;
- a budget handback resumes on the fallback;
- a model-failure episode can switch mid-tick.

Counting a tick only against its admission key would let a claude-authored tick run its review on
oMLX without being counted there.

**The lease rides in an `AsyncLocalStorage` store**, the pattern check-permit.ts uses for
`holdingPermit`. The store is entered around `runner.tick()` in the launch pass
(src/orchestrator/orchestrator-launch.ts), around the vet task body, and around the resolver run.

**One choke point re-keys it.** Every run a loop makes (authoring, gate, landing and resolver)
goes through `LoopPi.runWithTransientRetry` (src/loop/loop-pi.ts). Before it calls `runPi`, it
calls `ensureProviderLease(seamConcurrencyKey(opts.config, piDefault))`:

| Lease in context | What happens |
| --- | --- |
| none (`tumwater tick`, unit tests) | no-op |
| same key | no-op |
| a different key | `lease.rekey(to)`: give the old key back first, waking its waiters, then wait for the new key's headroom while keeping the fleet permit. A re-key waiter queues ahead of every admission, because it holds a fleet permit nobody else can use while it waits. The director's lease re-keys by force and never waits |

**The lease is sticky.** It stays on the last run's key until the tick ends, and it is still
counted between runs, during the check, just as the fleet permit is today.

- So a single-provider fleet with cap = `maxConcurrent` behaves exactly as today.
- A local server never gets a new stream just because some tick paused for its suite. That
  matters because the suite competes for the same unified memory.
- Releasing the lease between runs is a possible follow-up (Out of scope).

**A re-key wait is visible.** It sets a landing-slot-style stage (`checkWaitStage` /
`resolveWaitStage`, src/landing/landing-slot.ts), so the row reads "waiting for an omlx slot"
instead of looking like a hung review.

**No deadlock.** A re-key waiter holds a fleet permit but no provider permit.

- Every holder of the key it waits for is running a model or a check, and check permits are never
  held across a model run. So the key always drains.
- Suppose all T fleet permits were held by re-key waiters on key K. Then nobody would hold K, so
  K would have headroom.

A unit test pins both properties.

One wait could break the first property: a worktree pool slot, when `worktreeSlots` is set below
the number of permit holders.

- How it would deadlock: a tick granted key K waits for a slot, while the slot's holder (a vet
  re-keying to K mid-run) waits for K.
- The rule that prevents it: a lease never holds a provider key while it waits for a pool slot.
  - When `leaseSlot` (src/git/worktree-pool.ts) has to wait, it drops the context lease's key
    first, which never waits.
  - The next run's `ensureProviderLease` takes a key again, as an ordinary re-key.

### 6. Priority headroom and the vet limit

- **Priority headroom.** `workReserveCount` (src/scheduling/claims.ts) withholds fleet permits
  from maintenance while a work loop has work to take.
  - With caps, a work loop whose provider is full cannot use a reserved permit. Withholding one
    then only idles a slot that another provider's maintenance tick could use.
  - So a work loop counts toward the reserve only while its provider key has headroom or is
    uncapped.
- **Vet limit.** `vetLimit` (src/landing/landing-vetting.ts) stays a function of the fleet total.

### 7. Live reload

- config-live.ts already resizes the semaphore on a `maxConcurrent` edit. It now also calls
  `setKeyCaps` on a `maxConcurrentPerProvider` edit.
- It emits `provider_concurrency_changed` `{ provider, from, to }` for each changed key.
  event-format.ts renders it like `max_concurrent_changed`, with no warning prefix.
- Like `maxConcurrent`, the key is skipped by the generic `config_changed` diff (`changedConfigKeys`
  in src/config/config.ts), because it has its own event.
- A shrink never preempts.

### 8. Observability

- **Orchestrator info** (src/fleet/orchestrator-info.ts) gets a new `permits` field, set from the
  pool's `snapshot()`. It is written through `assignInfoFieldIfChanged`, like `budget` and `disk`.
- **Loop rows.**
  - A parked waiter stores its key as `parkedOn`, beside `parkedSince` (src/loop/loop-state.ts).
  - status-model.ts renders `awaiting omlx slot 2m` when that key is the binding limit in the
    published snapshot, and today's `awaiting slot 2m` otherwise.
  - gui-client-model.ts maps both to its "Waiting for a slot" chip, with the provider in the
    detail.
- **Fleet line.** `tumwater status`, the TUI header and the GUI fleet tile show
  `slots 5/8 · omlx 3/3 · claude 2/6`. The provider part appears only while the map is set, so a
  fleet without it renders unchanged.
- **`tumwater role <id>`** names the role's provider key and that key's cap.
- **Doctor: a "provider concurrency" check.**
  - It lists every provider key any seam resolves to, with its cap. The seams are each role, the
    review gate, the resolver, the director and each tier's fallback.
  - It warns about:
    - a cap key that no seam resolves to (a typo, or a provider not in use);
    - a cap at or above `maxConcurrent`, which is inert;
    - a capped fleet with a seam that has no key, because pi's default provider is unreadable.
- **Docs.**
  - docs/config.md;
  - docs/how-it-works.md's concurrency bullets;
  - docs/backends.md "Match clients to slots": set the provider's cap, not the fleet total;
  - README.

### 9. Mixed claude + pi fleets

**What works today.** `routeModel` (src/config/model-selector.ts) picks the backend per seam:

- `claude/<id>` runs on claude;
- any other `provider/id` runs on pi;
- a bare id runs on the top-level `agent`.

Every seam carries its routed `agent` on its `ResolvedModelConfig`. A 2026-10-15 audit of the run
path found these follow the run's own backend, not the fleet's:

- session resume (session ledger, `agentSessionResumable`, tick-resume.ts's handoff on an agent
  mismatch);
- the reviewer's resume and follow-ups;
- the prompt dialect;
- the role-notes carrier;
- the watchdogs (`deps.agent`);
- the per-run subscription/API cost split.

Children run side by side safely. Each run builds its environment fresh (`agentBaseEnv`,
`claudeEnv`), nothing writes `process.env`, and `HF_TOKEN` survives the claude scrub.

**What breaks when a fleet mixes them.** The bugs below were found by reading the code; no test
covers any of them yet. Each fix lands with the test that shows the bug.

1. **The startup gate and doctor miss seams.**
   - `agentsInUse` (src/gates/startup-gate.ts) covers the top-level `agent`, each loop and the
     reviewer. It misses every budget-fallback pair, the model-failure fallback and the resolver.
   - So a claude seam that exists only as a `fallback`:
     - gets no binary check;
     - never runs `seedClaudeAccount`;
     - so has no account file, so `seamFree` judges it priced, so the budget gate refuses
       `fallback: "claude/…"` at the cap. The test that passes (test/budget-gates.test.ts) writes
       the account file by hand.
   - Doctor's `seamPairs` (src/doctor/doctor-model-checks.ts) misses the fallback pairs too:
     - `checkClaudeAuth` and `checkClaudeVersion` stand down;
     - a fallback's pi provider never gets `pi auth check`;
     - `checkAgentBinary` (on `agentsInUse`) and the claude checks (on `seamPairs`) can disagree
       about whether claude is in use at all.
   - A live edit that adds a claude seam re-runs neither the check nor the seed.
2. **Budget handback and the fallback breaker never match a claude pair.**
   - The tick records its pair from `cfg.provider` (src/loop/loop-tick.ts `setTickPair`), and
     `withModelOverrides` clears that field for a claude seam. The configured fallback pair keeps
     provider `claude`.
   - So `tickOnPair` (src/gates/budget-gates.ts) never matches, and a tick on a claude fallback
     is never handed back when the gate reopens.
   - The launch pass names the breaker's pair `?/claude-sonnet-5-5`
     (`modelPairName({ provider: cfg.provider, … })`), so a dead claude fallback is never
     demoted.
3. **The fleet hold blames the author's provider.**
   - `lastRateLimit` and `lastBackendFailure` (src/tick/tick-usage.ts) are stamped by every run a
     loop makes, the reviewer's and resolver's included. They carry no provider.
   - gate-polls.ts files them under the author seam's `runProvider`.
   - So a 429 storm on a claude reviewer holds the pi author's provider, and the review hold
     (`seamHoldKey(reviewRunConfig(…))`) never trips.
   - This affects any author and reviewer on different providers, pi-only fleets included.
4. **Follow-up turns read the primary seam.** `requestFollowUp` (src/loop/loop-pi.ts) builds
   `loopPiOpts` without the run's config. During a model-failure fallback on the other backend,
   the SUMMARY or stage-fix turn therefore:
   - writes its native log under the primary agent's name;
   - computes `--max-budget-usd` for the wrong agent.
5. **Claude rate-window readings from landing runs are lost.**
   - claude-account.json is written only at tick end, from the author's tick usage
     (src/tick/tick-finalize.ts).
   - A claude reviewer or resolver folds its readings into the author's usage through
     `foldLandingUsage`, and the next tick start resets that usage.
   - So a pi-author, claude-reviewer fleet rarely records the five-hour window, and the
     subscription hold gets little input.
6. **`ANTHROPIC_API_KEY` silently moves claude to API billing.** An operator who exports it for
   pi's `anthropic` provider makes every claude seam bill the API (claude prefers the key).
   `seedBilling` then records `api`, and subscription seams stop counting as free. Nothing
   warns.
7. **Displays drop the backend.**
   - The budget badge and fleet alert print a claude fallback as a bare
     `claude-sonnet-5-5`.
   - `modelFallbackView` (src/config/config-views.ts) loses the agent.
   - `fleetModelLabel` ignores routing, so flipping `agent` with bare ids emits no
     `model_changed`.
   - The role view shows billing only when the role's own primary seam is claude, not the
     reviewer's.

**The fix shape.** One list, one key.

- **One list: `seamsInUse(config)`.** It enumerates every seam the fleet can spawn: each enabled
  role, the review gate, the resolver, the director, each tier's budget fallback, and each
  model-failure fallback.
  - `agentsInUse`, doctor's `seamPairs`, the claude-account seed and the pi auth checks all read
    it.
  - config-live re-runs the binary check and the seed for a backend a live edit newly routes to.
    A missing binary is a warning event, not a crash.
- **One key: `seamHoldKey`.** Pairs and hold stamps are keyed by it, so `claude/<model>` means
  the same thing to the tick pair, the configured fallback pair, the breaker and the hold.
  - `setTickPair` records `{ provider: seamHoldKey(cfg), model }`.
  - The launch pass's `ranPair` uses the same.
  - The failure stamps carry the failing run's key, which LoopPi knows from the run's config.
    gate-polls.ts files each stamp under that key, falling back to `runProvider` for a stamp
    without one.
- **Landing runs** record their claude account readings when their fold sees them, through the
  same `observeClaudeAccount` tick-finalize.ts calls, so they never wait for the author's next
  tick end.
- **Doctor** warns when `ANTHROPIC_API_KEY` is set while `claude auth status` reports a claude.ai
  login: "claude seams will bill the API, not the subscription".
- **Display surfaces** print `agentQualifiedSelector` wherever they show a fallback or a review
  model.

**Routing a bare Claude model id to claude.** Today `"strong": "claude-opus-5-5"` under the
default `agent: "pi"` runs on pi as `--model claude-opus-5-5` with no provider. That needs pi's
`anthropic` provider and an API key, and the budget prices the pair as never free.

The operator's expectation is the natural one: a Claude model runs on the Claude CLI, and every
other provider runs on pi. So `routeModel` gets a new rule 3a, ahead of the top-level `agent`:

- **New rule:** a bare id that starts with `claude-` runs on `claude`.
- **Unchanged:** `anthropic/claude-…` and `openrouter/anthropic/claude-…` stay explicit pi
  routes, because a named provider still wins. Bare aliases (`sonnet`, `opus`) keep today's
  routing; a pi user may mean a pi pattern by them.
- **The result:** a mixed fleet needs no `agent` key and no prefix:

  ```json
  { "model": { "default": "huggingface/deepseek-ai/DeepSeek-V4.1-Flash:deepinfra",
               "strong": "claude-opus-5-5" },
    "fallback": "omlx/Qwen3.8-27B-MLX-oQ4e-mtp" }
  ```

  The default tier runs on pi through HF, the reviewer, plan role and resolver run on the claude
  CLI, and the fallback runs on pi through oMLX. All of it runs concurrently, under each
  provider's cap.
- **Behaviour change:** a config that leans on pi's anthropic provider through a bare `claude-…`
  id moves to the claude CLI. Doctor's routing table (part 1/4's seam list) shows which backend
  each seam runs on, and the docs name `anthropic/…` as the way to keep pi.

**The end-to-end test.** No orchestrator-level test runs fake-claude (test/fakes/fake-claude.ts)
and the fake pi shim (test/fakes/fake-pi.ts) together today. A new e2e case does. Its config has
the default tier on `omlx/…` (fake pi) and the strong tier on `claude-sonnet-5-5` (fake claude).
It asserts:

- the author's run spawned pi and the reviewer's spawned claude, read from each fake's argv log;
- both landed;
- each run's native log sits at its own `role.agent` path;
- the tick and review events name the right selectors.

It is the harness every later part of both series extends. Examples: a claude fallback handed
back; a reviewer storm held under `claude`; the provider caps with both backends in flight.

**The live check.** Once the series lands, the operator, or a session the operator asks, runs
one bounded `tumwater run --once` in a scratch repo:

- config: one role on HF or oMLX through pi, and the review gate on `claude-…`;
- `maxConcurrentPerProvider` set;
- `tumwater status` captured mid-run and `tumwater doctor` run.

This follows role-catalog's guidance for real model-backed runs: one enabled role, wall-capped,
and killed when done.

## Testing

- **Semaphore unit tests** (test/semaphore.test.ts):
  - two providers fill independently under one total;
  - a full key does not block a later waiter on another key;
  - FIFO within a key, and tier order across keys;
  - the reserve still applies to tier ≥ 1 waiters only;
  - `setKeyCaps` grows and wakes waiters, and shrinks without preempting;
  - re-key releases the old key before waiting, and a re-key waiter beats admissions;
  - forced (director) acquires overshoot by at most one and block further grants on that key;
  - the no-deadlock property from §5.
- **Orchestrator tests**, beside test/orchestrator-permits.e2e.test.ts. That tier waits on real
  timers and runs through `npm run test:e2e`, not the gating `npm test`. The tests use the fake
  pi shim, with each role's provider taken from its selector. Given `maxConcurrent` 4 and
  `{ "omlx": 1 }`, with two roles on omlx and two on `huggingface`:
  - at most one omlx run is in flight at once;
  - both huggingface runs proceed beside it;
  - the waiting omlx role renders `awaiting omlx slot`.
- **A re-key test.** An author on `huggingface` with the reviewer on capped `omlx` waits for the
  omlx slot at its gate, and the `huggingface` count drops while it waits.
- **The mixed-fleet end-to-end test from §9**, extended by each later part. It runs pi and claude
  runs concurrently under both the provider caps and the fleet total.

## Phases

Two series in PLANS.md. Each series is ordered by `requires … landed`, and the two series are
independent of each other.

- **Mixed claude + pi fleets** is listed first, because it fixes live bugs:
  1. one `seamsInUse` list for the startup gate, doctor and the claude seed, plus the e2e test
     with both fakes;
  2. tick pairs, the breaker and fleet-hold stamps keyed by the seam that ran, plus follow-up
     opts;
  3. landing runs keep the claude window, the `ANTHROPIC_API_KEY` warning, and agent-qualified
     displays;
  4. bare `claude-…` ids route to claude, plus the "Mixing providers" docs.
- **Per-provider concurrency caps:**
  1. the keyed permit pool in `Semaphore`, plus `seamConcurrencyKey` (pure, with no behavior
     change);
  2. `maxConcurrentPerProvider`, which caps role-tick admission, applied live;
  3. landing vets, the resolver and the director count against their provider, plus the
     reserve sizing;
  4. a tick's lease follows its runs (re-keying), plus the pool-slot wait rule;
  5. status, TUI, GUI, role view, doctor and docs.

Both series touch src/orchestrator/orchestrator-launch.ts. Mixed part 2/4 changes `ranPair`, and
caps parts 2/5–4/5 change the acquire and release. These are separate hunks, so either order
merges.

## Decisions

Made in this plan; each is open to the operator's veto.

1. **The director counts toward its provider but never waits** (§4). The alternative, full
   exemption, would let a director session hold a local server at cap + 1 for its whole length.
2. **Leases are sticky across a tick's check** (§5). This keeps parity with today's
   `maxConcurrent` and protects unified memory. Run-scoped leases are the follow-up if a local
   cap starves.
3. **A bare `claude-…` id routes to claude** (§9). A config that used pi's `anthropic` provider
   through a bare id moves to the claude CLI. `anthropic/claude-…` keeps pi.
4. **Unknown provider names in the map are not validation errors**, only doctor warnings (§1).
   A provider may come into use only through a fallback, or through a pi `models.json` edit
   tumwater does not watch.

## Risks

- **Sticky leases under-use a local server** whose ticks spend long stretches in checks. The trade
  is deliberate, for parity and memory safety (§5). If live data shows a starved local cap, make
  leases run-scoped then.
- **A stale admission key.** A tick admitted on its author key can switch providers before its
  first run, for example when the budget trips between parking and the grant. The first run
  re-keys, so the count self-corrects within the tick, at the price of a possible wait at that
  first run.
- **Two pi provider names on one server** (say `omlx` plus a second alias pointing at
  127.0.0.1:8000) are two keys, so the server could see the sum of both caps. Doctor cannot
  detect this; the docs say to give one server one provider name.

## Out of scope

- Run-scoped provider leases, released between runs (see Risks).
- Provider groups (one cap shared by several provider names) and per-model caps.
- Cross-process accounting. Like today's semaphore, the pool is in-process. A manual
  `tumwater tick` beside a running fleet is not counted.
- Adaptive caps learned from 429s or latency. The fleet hold already answers storms.
