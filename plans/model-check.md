# Model check — prove a model pair can answer before the team runs on it

Planned and implemented 2026-10-30 · requested by user

## Goal

Every provider/model pair the team can run on answers one short probe with a known answer before
its roles run on it. A pair that answers with nothing, or with the wrong word, holds the roles on
it, is named in a warning with the reply it gave, and is checked again on a back-off until it
answers. Then its roles resume by themselves.

## Motivation

A broken model server looks to tumwater like a model that keeps finishing without changes. On
2026-10-30 at 02:24 the default tier moved to a local llama-server (`flintrunner/flint`). Its
Metal flash-attention prefill kernel returned word salad for any prompt past a few dozen tokens.
Every run on it ended `no_change` with "the agent finished without changes and without declaring
nothing-to-do", one burned 32,768 output tokens on a loop, and nothing in tumwater noticed: the
stop reason was "stop", the text was non-empty, and `tumwater doctor` called the free pair
"serving not verified". The oMLX fallback that served nothing (2026-09-19) and deepinfra's
first-reply hang (2026-10-29) had the same shape. A short probe with a known answer catches
each of them in seconds.

## Design

- **The probe** (`src/model-check/model-check-probe.ts`): a ~230-token paragraph about a made-up
  river, then "which river does the Varrow join? one word". The answer, *Isselmar*, is in the
  paragraph and nowhere else, so no model answers from memory and no broken one hits it by
  chance. The prompt is long on purpose: on Flint a prompt under ~32 tokens took a different
  kernel path that worked. The probe goes through `runAgent`, the same backend path every role
  run takes (pi, claude, opencode, codex), in a scratch dir under `.tumwater/model-check`, with a
  throwaway session and a 5-minute budget. Its transcript is `.tumwater/log/_model-check.pi.jsonl`.
  The verdict is `verified` when the reply names the river. Otherwise it is `wrong answer`, which
  quotes the first 120 characters of the reply, or `no reply`, which carries the run's own error.
- **When a pair is checked** (`model-check.ts`, `model-check-gate.ts`): every poll collects the
  pairs in use. These are each runner's next-run seam (which names the budget fallback during a
  cap episode), the reviewer and resolver seams, and every step of every tier's fallback chain.
  A pair seen for the first time is probed at once: at startup, after a config edit routes a
  seam to it, or when a budget fallback engages it. A pair that leaves use is forgotten. A
  failed pair is probed again after 1 minute, then the wait doubles up to 30 minutes. A
  verified pair is probed again when a run on it ends `no_change` without declaring
  nothing-to-do (`RunOutcome.undeclared`), at most every 10 minutes.
- **Holds**: a due role waits (skip reason `model-check`, shown as `waiting: model check`) while
  its next run's pair is not verified. With review on, every role but the director also waits
  while the reviewer's pair is not verified, because no change can merge without a review. The
  start gate reads the latest verdict, so a run parked for a permit does not start on a pair
  that failed meanwhile. In-flight runs finish.
- **Fallback** (`budget-fallback-view.ts`, added 2026-10-30): a tier whose own primary failed
  its check runs on the first step that the check has verified, from its own chain or one it may
  borrow (`BORROW_ORDER`). This applies at any spend. At the cap it covers a tier the cap leaves
  on its primary (a free one), since the cap already moves the priced tiers.
  - Only that tier's own primary seams move. The other tiers keep their primaries, and a role or
    reviewer pinned to another pair keeps its pin. When the reviewer's tier moves, its timeout
    floor rises to `FALLBACK_REVIEW_TIMEOUT_S`, as at the cap.
  - The `chain` block names the move with reason `model-check`. The badge reads
    `default → omlx/qwen (model check)`, and the role view reads "primary failed its model
    check". `fallback_switched` logs the move.
  - The check keeps probing the failed primary on its back-off, under the seam label
    `primary:<tier>`, because no runner names it any more. Once it answers, the next poll moves
    the tier back, and `fallback_switched` reads `available`. Runs already on the step finish
    there.
  - With no verified step, the tier stays held on its primary.
  - The image-reroute regime (`budgetFallbackActive`) stays the cap's alone.
  - At the cap, the budget gate's serving resolution also skips a chain step that failed its
    check, the same way it skips a demoted step.
- **Surfaces**: one `warning` event when a pair enters `failed`, naming the pair, the reply
  excerpt, the seams that wait and the next check. One `model_check_passed` event when a failed
  pair answers again. The orchestrator publishes `modelChecks` in `orchestrator.json`. The
  dashboards and TUI raise a red `modelcheck` alert per failed pair. `tumwater doctor` has a
  `model check` row, and its `over-cap model` row replaces "serving not verified" with the
  running team's verdict.
- **Scope**: on for a long-running team (`tumwater start`), off for a `--once` round and for
  in-process tests that inject no prober. Doctor never probes a model itself.

## Not covered (follow-ups)

- At the cap, a tier the cap moves still runs on a step that failed its check. The serving
  resolution steps past the step, and so do the `chain` block and the pause set. But the view
  roles run under is built from the price-only resolution, so the roles run on the failed step
  and wait there. Found 2026-10-30 while adding the move above. A breaker demotion splits the
  same way by design, because its half-open probe runs on the demoted pair.
- The director keeps the live config, so a director whose primary failed waits rather than
  moving.
- A run already in flight on a pair that then fails its check runs to its end. It could be
  handed back resumably, like the budget reopen's `budget_handback`.
- Probe cost is not charged to any role's daily window. A probe costs a few hundred tokens.
- Verdicts are in memory only, so every restart (including self-redeploys) re-checks every pair
  and holds the roles for the probe's few seconds.
