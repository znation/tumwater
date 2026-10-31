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
  verified pair is probed again, at most every 10 minutes, when a run on it gives evidence it may
  have stopped answering properly (see Suspicion).
- **Suspicion** (added 2026-10-30, after the 2026-10-29 deepinfra hang held plan about 2 h a run):
  three run shapes re-check the pair the run is on.
  - The run ends `no_change` without declaring nothing-to-do (`RunOutcome.undeclared`): the
    Flint word-salad shape.
  - The run's last authoring agent run failed before its model replied at all
    (`RunOutcome.unanswered`, from `endedBeforeAnyReply` in `pi-run-result.ts`, set by
    `finalizeRun`). A 429, a refused request (context too large, session gone), a per-run
    budget cap and tumwater's own abort do not count: the provider answered, or tumwater
    stopped the run. The launch pass passes both outcome flags to the gate through
    `LaunchContext.suspectPair`.
  - A run's model request is still unanswered after `toolCallStallSeconds`, the watchdog's
    `model request unanswered` warning. A run that waits like this may not end for hours, so
    this does not wait for the outcome. The watchdog reports the wait and its end through
    `PiRunOptions.onUnansweredReply`. For the role's own authoring agent runs, `RunnerPi` passes
    it to the runner, which publishes `RoleRunner.unansweredRunPair()`. The gate's poll reads
    that pair from every runner and suspects it on every poll while the wait lasts. The rate
    limit makes that one probe per 10 minutes, so a hang the probe does not reproduce is
    checked again while it lasts. The runner never sees the gate. Merge and review runs, which
    the merge slot runs outside any role run, do not report a wait.
- **Holds**: a due role waits (skip reason `model-check`, shown as `waiting: model check`) while
  its next run's pair is not verified. With review on, every role but the director also waits
  while the reviewer's pair is not verified, because no change can merge without a review. The
  start gate reads the latest verdict, so a run parked for a permit does not start on a pair
  that failed meanwhile. In-flight runs finish, except a run that is waiting on an unanswered
  request (see In-flight runs).
- **In-flight runs** (decided 2026-10-30): when a pair fails its check, a run on it that is
  waiting on an unanswered request (`unansweredRunPair` names the pair) is handed back
  resumably. `RoleRunner.handBackRun("model-check")` keeps its session and worktree edits, and
  the run ends `aborted` with resume cause `model-check`. The role resumes the session on its
  next run, on whatever its tier runs on then. That is the verified step the tier moves to (see
  Fallback), or else the same pair once it answers again, with the role held until it does. The
  bridge says the model stopped answering. The gate logs one warning per hand-back
  (`run handed back: …`). The director is handed back the same way; its prompt returns to the
  inbox, as on any abort.
  - Why: such a run produces nothing. On 2026-10-29 pi waited out its 30-minute idle timeout
    and retried three times, so the run held a team slot for about 2 h. Ending it loses no
    work, and the resume starts as soon as the tier runs on a verified pair, not when the
    backend gives up on a request.
  - Not handed back: a run on a failed pair whose requests are being answered. A probe failing
    while the run's own requests get replies is weak grounds for cutting real work. A run on a
    pair giving salad, the Flint shape, ends by itself soon enough with an undeclared
    `no_change`. Its session would be full of salad, so a resume would carry that forward.
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

- The director keeps the live config, so a director whose primary failed waits rather than
  moving.
- A run in flight on a pair that fails its check, and whose requests are being answered, runs
  to its end (see In-flight runs).
- The 2026-10-29 hang was keyed on the opening of pi's stock system prompt. The probe goes
  through pi with that same opening, so it reproduces that hang. A hang keyed on something only
  role prompts carry would pass the probe. The waiting run then keeps waiting, and its pair is
  re-checked every 10 minutes while the wait lasts.
- The mid-run wait is pi-only: the claude, opencode and codex translators emit no
  `message_start`, so on those backends only a run that ends before any reply re-checks its
  pair.
- Merge and review runs report no unanswered wait. A reviewer pair that stops answering is
  re-checked only through the role-run shapes.
- Probe cost is not charged to any role's daily window. A probe costs a few hundred tokens.
- Verdicts are in memory only, so every restart (including self-redeploys) re-checks every pair
  and holds the roles for the probe's few seconds.
