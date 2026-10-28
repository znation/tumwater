# Fallback chain: what runs when the Claude subscription window runs out

**Mostly kept 2026-10-28** (user decision): [subtract.md](subtract.md) had retired the chain
steps and the per-tier fallback maps on 2026-10-26 (Subtract part 5/6). The user kept the budget
fallback, so the chains, the per-tier maps and the breaker stay as the over-cap route. Only this
plan's first trigger — a used-up subscription window moving a tier onto its chain before the cap
— goes, with the window carve-outs (Subtract part 5d/6).

Planned 2026-10-16 · requested by user · not started

## Goal

When the claude.ai subscription's 5-hour or weekly usage window runs out, the team should keep
working on the next model you listed, not stop. More generally, you should be able to list an
ordered **chain** of models per tier. The team runs each job on the first model in the chain
that is available right now, for example:

1. Claude on the subscription (free while the window lasts).
2. A paid model with its own daily cap: Claude extra usage, or another provider such as HF
   Inference Providers.
3. A free local model.

## What happens today

### The subscription window (plans/agent-backends.md §7–§8)

What happens depends on whether the account allows extra usage ("overage"). This account does:
every `rate_limit_event` in the Claude native logs on disk reports `overageStatus: "allowed"`.

| Account | What claude does at 100% of a window | What tumwater does |
| --- | --- | --- |
| Overage off, or the org's extra-usage limit spent | The run gets a `rejected` rate-limit event and stops | See "Overage off" below |
| Overage on (this account) | Keeps running, billed as extra usage (`isUsingOverage: true`) | See "Overage on" below |

**Overage off.** Tumwater pauses; it never tries the fallback.

- The rejected run keeps its worktree and session (src/tick/tick-verdict.ts window arm). Its
  per-run 429 retry is skipped (src/loop/loop-pi.ts).
- `pollFleetHold` places a `claude` hold until the window's `resetsAt`
  (`claudeWindowObservation`, src/fleet/fleet-polls.ts). Every role run on subscription Claude
  waits. For the weekly window that can be days.
- With review on and a Claude reviewer, nothing can merge. `reviewHeld` then holds every role,
  including roles on pi.
- The director is exempt from holds and has no backoff. Its prompt goes back to the inbox after
  each rejected run and runs again on the next poll. After 10 failures in a row the
  repeated-failure pause (`ERROR_STREAK_BREAKER`) stops the director until you resume it by hand,
  even after the window resets. Found by reading the code; filed in BUGS.md.
- The model-failure fallback (src/loop/model-fallback.ts) needs 3 failed runs in a row to trip.
  The hold stops each role after its first rejected run, so it never trips.

**Overage on.** Tumwater keeps running on paid extra usage until the daily cap.

- A run that saw `isUsingOverage` counts its whole cost as real spend (`runCostIsReal`).
- While the account is in overage, Claude is not free (`accountUsesOverage`,
  src/pi/pi-models.ts). At `maxDailyCostUsd` ($15 in tumwater.json) Claude model jobs therefore
  move to the over-cap model (`fallbackModel`, `qwenrunner/qwen3.8-27b`). If that model does not
  serve, roles pause until local midnight.
- After the window resets they stay on the over-cap model until midnight, because the reset
  window keeps its overage flag. Reproduced against the built code on 2026-10-16; filed in
  BUGS.md.

### Evidence and fallback config

**Evidence.** Neither path has run live yet.

- The Claude native logs under `.tumwater/log/` hold 1,797 `rate_limit_event`s, all `allowed`.
- Peak utilization was 72% of the 5h window and 53% of the weekly window.
- `events.jsonl` has no `claude_window_*` event.
- As of 2026-10-16 14:36 neither `qwenrunner` (127.0.0.1:8090) nor oMLX (:8000) is listening.
  A team that reached the cap now would engage the over-cap model and lose three runs to it.
  The breaker (src/budget/fallback-breaker.ts) would then pause the roles and probe every 5–30
  min. `tumwater doctor` reports the pair as "priced at zero (cost n/a), serving not verified".

**Fallback config today** (plans/fallback-model.md, plans/model-tiers.md):

- Each tier gets **one** fallback (`fallback: string | {small, default, strong}`), and a tier
  with none borrows another tier's.
- It must be **free**: priced at zero in pi's `models.json`, or subscription Claude not in
  overage.
- It is used for two things only:
  - the daily cap: the budget gate moves priced model jobs to it;
  - three provider failures in a row on one role: the model-failure fallback.
- A tier never moves because its primary is out of subscription quota. Chains of more than one
  fallback, and paid fallbacks, were explicitly out of scope.

## Design

### Terms

- **Chain:** a tier's primary model (`model`) followed by its `fallback` steps, in order.
- **Step:** one entry in the chain.
- **Available:** whether a step may take a new run right now (see the rules table below).
- Each poll, every tier runs on its **first available step**. If no step in its own chain is
  available, it borrows the other tiers' fallback steps in today's borrow order (small → default
  → strong; default → strong → small; strong → default, never small). If none of those is
  available either, the tier pauses.

The one structural change is that **the primary is tested for availability like any other
step**. Today the primary moves only at the team cap. Testing it is what turns a used-up window
into a fallback instead of a hold.

### Config

```
fallback := Chain | { small?: Chain | "pause", default?: Chain | "pause", strong?: Chain | "pause" }
Chain    := Step | Step[]
Step     := "<model id>" | { "model": "<model id>", "maxDailyCostUsd"?: number }
```

The chain you described, for an `agent: "claude"` team (tier primaries Haiku, Sonnet and Opus 5.5
on the subscription):

```json
"fallback": {
  "default": [
    { "backend": "claude", "model": "claude-sonnet-5-5", "maxDailyCostUsd": 10 },
    { "model": "huggingface/deepseek-ai/DeepSeek-V4-Flash-0731:deepinfra", "maxDailyCostUsd": 5 },
    "qwenrunner/qwen3.8-27b"
  ],
  "strong": [
    { "model": "huggingface/deepseek-ai/DeepSeek-V4-Flash-0731:deepinfra", "maxDailyCostUsd": 5 },
    "qwenrunner/qwen3.8-27b"
  ]
},
"maxDailyCostUsd": 15
```

A step names its own backend with `backend` beside `model` (`{ "backend": "pi", "model":
"qwenrunner/qwen3.8-27b" }` is the explicit form of the last string step); a step without one keeps
the routing it has under the team's top-level `backend`. The `claude/<id>` step spelling still
loads but is retiring.

The default tier's primary is Sonnet on the subscription, so it is that chain's first Claude model.
Listing Sonnet again as the first fallback step makes it the chain's extra-usage step. When the
window runs out, the default tier spends up to $10 of extra usage, then up to $5 on HF, then runs
locally.

- A string or a one-element list is today's single fallback, so existing configs read
  unchanged. The legacy `fallbackModel` object is a one-step `default` chain.
- `"pause"` stays a whole-tier value (no fallback for that tier). It is not a list element:
  every chain already ends in a pause.
- `maxDailyCostUsd` on a step caps the real spend on that step's model for the local day,
  summed over every role. The team-wide `maxDailyCostUsd` stays the ceiling over everything
  priced.
- **Claude models by position (decided 2026-10-16, D1).**
  - The first Claude model in a chain runs on the subscription only. That includes the primary,
    and a tier default from `agent: "claude"`.
  - Any Claude model listed after it in the same chain may spend extra usage, within its own cap
    and the team cap. So a chain can list the same model twice, and the second listing is its
    extra-usage step.
  - A step borrowed from another tier keeps the position it has in the chain that declares it.
  - On API billing every Claude step is priced, and position does not matter.
- A priced step is now allowed. It no longer has to be free, because the availability rules
  below never let a priced step run past a cap.

### When a step is available

| Step | Available when |
| --- | --- |
| pi model priced at zero | its breaker is serving |
| pi model with a price, or Claude on API billing | team spend < team cap; step spend < its own cap, if it has one; breaker serving |
| The chain's first Claude model, on the subscription | no window counts as **used up** (see below), ignoring windows whose `resetsAt` has passed; breaker serving |
| A later Claude model in the same chain, on the subscription | the account allows overage (last `overageStatus` is not `rejected`); no window is `rejected`; team spend < team cap; step spend < step cap; breaker serving |

A subscription window counts as used up when any one of these holds:

- it is `rejected`;
- it reports `isUsingOverage`;
- its utilization has reached its reserve (see Reserve below).

The primary is step 0 and follows the same rules.

- A priced primary is unavailable at the team cap, as today.
- A subscription Claude primary is unavailable while a window is used up. This is new.

Primaries keep their health check where it is today: the per-role model-failure episode. Every
later step gets a fallback breaker, which today covers only the one fallback pair.

### What happens when a window is used up

- Every subscription Claude model job whose tier has an available later step moves to that
  step on the next poll. That covers role runs, the reviewer and the conflict resolver.
  `applyFallbackModel` already installs a per-tier pair while keeping some jobs in place; it gets
  a "keep this job" predicate (its step 0 is available) in place of today's "this job is free".
- The `claude` subscription-window hold stays. It now only stops jobs that have nowhere to go: a
  tier with no fallback, or one whose whole chain is unavailable. With no fallback configured,
  behavior is exactly today's.
- `reviewHeld` must read the reviewer's provider from the config that merges actually review
  under, not from the live config. Today it calls `reviewRunConfig(liveConfig)` in
  src/orchestrator/orchestrator.ts. That still names `claude` after the reviewer has moved, so it
  would keep the whole team waiting.
- The run that hit the rejection keeps its worktree, as today. Its next run is on another
  backend, so src/tick/tick-resume.ts already resumes it as a `handoff`: a fresh session over the
  kept worktree, with the bridge prompt.
- When `resetsAt` passes, step 0 is available again and the tier returns to it. Runs still in
  flight on a later step are handed back, the way `budget_handback` hands runs back at midnight
  today (decision D3).

### Overage

Overage is real money, so only a Claude model listed after the chain's first one spends it.

- The first Claude model is unavailable once a reading shows `isUsingOverage`. The run that
  crossed into overage finishes in overage, because tumwater cannot stop the CLI from crossing,
  and the next poll moves on. The cost of that is at most one run per role running at once. The
  reserve below avoids even that.
- A later Claude model runs the ordinary `claude` command. Its spend is the real spend on that
  pair, because subscription runs count only as estimated spend. So its cap caps extra usage
  directly. When it is the same model as the first one, the two share a pair name, and only the
  later step ever has real spend.
- **Behavior change:** an account that allows overage, with no later Claude model in its chain,
  stops at the end of the window instead of spending extra usage up to the team cap.
  - That matches the live team's config today: `agent: "claude"`, with `fallbackModel`
    `qwenrunner/qwen3.8-27b`.
  - Until part 5 merges, today's behavior holds.
- Prerequisite: the BUGS.md 2026-10-16 entry. A window whose `resetsAt` has passed must not read
  as in overage.

### Spend per step

- `LoopState` gains `dayCostByPair`: real USD per model pair name (`modelPairName`) for the same
  local day as `dayCostUsd`.
- `recordDailyCost` folds each run's real cost into it. A step's spend is the sum over roles.
  Estimated (subscription) spend never counts.
- For Claude runs billed to the API, the per-run `--max-budget-usd` (src/agent/claude/
  claude-args.ts) becomes the lower of the team's and the step's remaining budget.
- Overage runs get no per-run cap. Whether `--max-budget-usd` counts the in-window share is
  unverified.

### Reserve

- `claudeWindowReserve` is a map from window type to a fraction, e.g.
  `{ "seven_day": 0.8, "five_hour": 0.95 }`.
- At or past that utilization, the subscription counts as used up for the team until the window
  resets.
- The window belongs to the account, and that account is the one you use interactively too. A
  team that uses up the weekly window on Tuesday leaves you on extra usage, or locked out, until
  it resets. The reserve also keeps runs from crossing into overage.
- Utilization comes only from runs, at about two readings per run in the logs, so the team learns
  it crossed the line one run late.
- A later Claude model would spend the reserved quota before it reaches extra usage. So past
  the reserve it waits too, until a reading shows `isUsingOverage`.
- The director is exempt: it runs your own prompts.

### Director

- The director keeps ignoring caps, because an explicit prompt outranks the cap, as today.
- It now follows **availability** instead of always keeping the live config. It walks the same
  chain, treating priced steps as available whatever their spend and skipping the reserve. A
  used-up window or a demoted step therefore moves it as well.
- With nowhere to go, it waits for the reset like every other role. That waiting is the BUGS.md
  fix for its back-to-back failed runs, which part 2 builds on.

### Events and surfaces

- `fallback_switched` is logged on every poll where a tier's step changes. It carries each
  changed tier's `from`, `to` and `reason`. The reasons are `cap`, `step-cap`, `window`,
  `reserve`, `demoted` and `available`.
- `claude_window_limited` and `claude_window_reset` keep their meaning and gain a `tiers` field:
  where each tier's work went.
- The budget badge and the side card name each tier that is off step 0, with its reason and when
  it returns: `default → DeepSeek-V4-Flash $3.10/$5 · Claude 5h resets 17:40`.
- The role view names the step: "running on fallback 2 of 3 (5h window used up, resets 17:40)".
- A new `tumwater doctor` check, "fallback chain", lists each tier's steps and whether each one
  is available, and why not.
  - For a step served from a local base URL (127.0.0.1 or localhost in pi's `models.json`), it
    does a 2-second `GET <baseUrl>/models`.
  - That turns "serving not verified" into "not running" in the case found above.

## Parts (PLANS.md "Fallback chain, part i/7")

1. A used-up subscription window moves Claude model jobs to their tier's existing fallback, with
   the `reviewHeld` fix, the handback on reset, and the events. No prerequisite.
2. The director follows a used-up window to the fallback. Builds on the BUGS.md fix that makes
   it wait for the reset instead of failing back to back. Requires 1.
3. Fallback chains: the list form, the walk, a breaker for every step, and `seamsInUse`/doctor
   sweeping every step. Requires 1.
4. Priced steps with their own daily caps (`dayCostByPair`). Requires 3.
5. Extra usage by position: a chain's first Claude model stops at the end of the window, and
   later Claude models spend extra usage within their caps. Builds on the BUGS.md stale-overage
   fix. Requires 4.
6. `claudeWindowReserve`, including the rule that later Claude models wait past the reserve.
   Requires 5.
7. Surfaces: the doctor "fallback chain" check with the local probe, and the badge, TUI, GUI and
   role-view chain lines. Requires 2 and 6.
   Split 2026-10-16 into 7a/7 (the doctor check and the probe), 7b/7 (the gate's `chain` block and
   `fallback_switched`), 7c/7 (badge, side card, TUI, alerts) and 7d/7 (role view, `claude window`
   row); 7c and 7d require 7b.

Part 1 alone answers the question that started this: a used-up window falls back instead of
pausing. Parts 1–5 give the chain you described.

## Decisions

- **D1, extra usage (decided 2026-10-16):**
  - A chain's first Claude model stops at the end of the window.
  - A Claude model listed after it in the same chain spends extra usage, within its caps.
  - Without a later Claude model, the team spends no extra usage.
  - Until part 5 merges, today's behavior holds: extra usage up to the team cap.
- **D2, reserve default:** recommended off by default, since tumwater runs on any account. For
  this tumwater.json, `{ "seven_day": 0.8 }`, so the team leaves a fifth of the week for you.
- **D3, hand back in-flight runs when the window resets:** recommended yes, matching midnight's
  `budget_handback`. The alternative is to let them finish on the fallback.

## Out of scope

- **Claude Code billed to an API key as its own step, beside a subscription.** The account file
  holds one billing identity and claude prefers `ANTHROPIC_API_KEY` for every run. A per-step key
  would mean per-step credentials and billing state. A pi `anthropic/…` model with an API key is
  a priced pi step and works from part 4.
- **Provider 429 or outage holds moving roles down the chain.** Storms stay holds. The per-role
  model-failure fallback moves a role to its first available fallback step and does not walk
  further.
- **Ordering steps by price, per-role chains, more than three tiers, and forecasting when a
  window will run out.**

## Risks

- **The rejected path has never fired live.** The translator's mapping (`rate_limit_event`
  `rejected` → `transientRateLimit`, `retryAfterSeconds` from `resetsAt`) is tested only with
  synthetic events. Part 1's tests should build their events from a recorded 2.1.295 event, with
  the status changed.
- **Different backends, different behavior.** Claude has a 1M-token context; local models have
  131K. Each run starts a fresh session, so the switch is safe; the handoff bridge covers a kept
  worktree. Quality drops on the local step, which is the point of putting paid steps first.
- **The Plain terms rename series moves many of the files named here** (src/fleet → src/team,
  src/tick → src/run, landing → merge). Each part names today's paths; use the new one when a
  rename has merged first.
