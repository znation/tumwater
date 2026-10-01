# Feature: Model fallback on repeated backend failures

## Summary

When a role's primary model keeps failing, the harness temporarily runs that role's
ticks on a fallback model, keeps trying the primary in the background, and switches
back automatically once the primary is healthy again.

- **Trigger.** Per role, N consecutive provider-level failures (connection errors,
  timeouts, stream severances — the transient classes already recognized by the
  harness) trip a fallback episode. One-off failures do nothing new; the existing
  retry/backoff still handles blips.
- **Fallback model.** Configured once per project: `fallbackModel` in
  `tumwater.json` (same provider, a different model). Absent config = feature off,
  behavior identical to today.
- **During an episode.** The role's ticks run on the fallback model. Tick prompts,
  resume behavior, and session handling are unchanged apart from the model id.
- **Return policy.** After each fallback tick, the harness periodically probes the
  primary with a cheap canary request. Once a probe succeeds (and optionally one
  confirmation), the role switches back and a `model_fallback_ended` event records it.
- **Observability.** Episode start/end is logged as events (`model_fallback_started`,
  `model_fallback_ended`) with the reason string that tripped it, so dashboards,
  history, and the failure digest show exactly when and why a role was off-model.
- **Budget honesty.** Fallback ticks are costed against the same per-role ledger;
  reports can show which ticks ran off-model.

## User experience

1. Operator sets `"fallbackModel": { "provider": "openai", "model": "gpt-4o-mini" }`.
2. The primary provider starts timing out for `bugfix` — after 3 straight failures,
   the dashboard shows "bugfix: on fallback model (primary failing)".
3. Ticks keep making progress on the fallback instead of burning error-streaks.
4. Primary recovers; next canary probe succeeds; the role flips back and history
   shows the episode start/end times.

## Rationale

- Today, a provider outage on one model stalls or fails that role's loop outright,
  converting a backend problem into missed project work and error-streak noise.
  Fallback converts "down for hours" into "degraded but productive."
- Per-role (not fleet-wide) fallback keeps a healthy primary serving other roles —
  matching how the harness already treats failures as per-loop state.

## Constraints and notes

- Only provider-level failure classes count; review rejections, red builds, and
  other *content* failures never trigger fallback.
- No mixing within a single tick: a tick runs entirely on one model.
- The fallback model is trusted with the same prompts as primary — documentation
  should say so plainly (same context, same permissions) so operators choose it
  deliberately.
- Fallback status must be visible everywhere model choice matters (role inspection,
  dashboards, tick detail), not just in logs.
- Zero runtime dependencies; probes use the existing pi/model invocation path.
