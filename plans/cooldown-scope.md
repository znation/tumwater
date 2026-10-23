# Full-team stoppages — pause the tributary, not the river

Planned 2026-10-23 · requested by user (from the 2026-10-21→23 flow audit). No shared design
document; one PLANS.md entry, filed here for the reasoning.

## The problem

Two stoppage families hold the *whole team* for causes that are narrow, and the live instance
shows their cost:

- **The restart cooldown (the live evidence):** team paused 2026-10-23T09:51Z, all 30 roles
  stopped, auto-restart blocked by the post-restart cooldown "until 2026-10-23T13:04:10Z"
  (state/orchestrator.json) over a stale build 15 commits ahead — **3 h 13 m of full stop**. The
  cooldown exists as a rate limit against restart storms
  (src/redeploy/redeploy-policy.ts, `RESTART_COOLDOWN_MS`), and the urgency carve-out
  (BUGS.md 2026-09-30) already cuts it when the *running* build's own commit is red — but a
  merely *stale* build (the common case: work landed, build didn't move) waits the full window
  while the whole team idles.
- **Team-wide reviewer holds:** `reviewHeld` (a provider hold on the reviewer's provider blocks
  every role — "nothing could merge") and `reviewStrongPaused` (an unresolvable strong tier
  holds the whole team) stopped all roles twice in the 58-h window. These dissolve as a side
  effect of [reviewer-as-role.md](reviewer-as-role.md) once the low-blast-radius roles' merges
  no longer wait on the reviewer — the hold's premise ("nothing could merge") stops being true
  for those roles. No separate entry is filed for them.

## The decision

**The restart cooldown's scope narrows: it limits restarts, not work.**

- **While a restart is merely pending (stale build, cooldown running), roles keep authoring.**
  A queued change still enters the merge queue; the merge pipeline still verifies and merges it
  on the *running* build — the running build's code is what has been executing all along, and a
  change it can verify is no less trustworthy than the work it already did today. What waits is
  only the redeploy itself.
- **What stays hard:** a red-running-build restart (the urgency carve-out's case) and the drain
  that precedes any swap — the cooldown narrows, the restart's own safety conditions do not.

**The team pause stays a full stop.** `tumwater pause` is the operator's explicit "stop the
river" command (docs/glossary.md: "paused — only a pause you set"); the live instance's pause is
the operator acting, not a gate misfiring. The error-streak breaker also stays per-role as
built — it already pauses only the failing role, and its manual-only lift is deliberate.

## What lands

1. **Cooldown-scoped holds (single entry):** the restart-cooldown deferral stops holding role
   runs and merges (src/redeploy/ + orchestrator-scheduling's `holdForRestart` reading it);
   only the redeploy waits. The build-stale alert's advice updates — "restarting when idle"
   becomes "restarting after cooldown; work continues".
2. **Docs:** docs/how-it-works.md's redeploy section states the narrowed scope; the glossary's
   `update available` row gains "work continues while the restart waits".

## Risks

- **A change merges on the stale build that the new build would reject:** the same risk any
  merge takes today when a build goes stale mid-flight; the new build's own startup check
  catches environmental breaks, and a rejected-on-new-build main is the fast-merge world's
  normal revert path.
- **Restart-storm reintroduction:** the cooldown still rate-limits restarts themselves — only
  the collateral work stop is removed, and the storm the rate limit guards against was never
  the *work*.
