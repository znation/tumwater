# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### A fresh project's `run --once` reports every bootstrap-held role as skipped `"paused"` — a reason no other command agrees with, and one the operator cannot lift (found by the qa role 2026-11-21)

- **Symptom:** on a project just created by `tumwater init` (which seeds `bootstrap.untilPlansDone: true`, INV-Q6), a one-shot round reports its bootstrap-held roles as skipped with reason `paused` — `"reason": "paused"` ×18 in `--json`, the same bare word repeated in the prose summary — while nothing is paused: `doctor pause` prints `ok pause not paused`, `resume --role <r>` answers `"status": "not_paused"`, `status --json` reports `pausedRoles: []`, and no `paused.json` or `paused-roles.json` exists under `.tumwater/`. The same payload names the real hold separately — a top-level `bootstrapHeld` array (`readme`, `organize`, `coverage`, `clean`, `dedupe`, `perf`, `qa`, `ci`, `security`, `robustness`, `improve`, `steward`, `bugfix`, `bugfix-2`, `bugfix-3`) beside a `bootstrap` progress object — so the `--once` report is the surface that drops the distinction. Following the reported reason sends the operator to `tumwater resume`, which is a no-op on a role that was never paused.
- **Reproduce:** deterministic, offline, no model. Build `dist` (`npm run build`), then in a scratch repo:
  ```sh
  mktemp -d; cd <dir>; git init -b main
  node <wt>/dist/src/cli.js init "Build a tiny markdown-to-html converter CLI in Python."
  # any pi will do; the shim prints an assistant message_end with TUMWATER_NOTHING_TO_DO
  TUMWATER_PI_BIN=<shim> node <wt>/dist/src/cli.js run --once --role readme --json
  ```
  Expected: the `readme` role runs, or is reported held by bootstrap. Actual: `{"runs":0,"skipped":[{"role":"readme","reason":"paused"}],"failures":[]}`, exit 0. The same fresh repo then shows `doctor pause` → `ok pause not paused` and `resume --role readme` → `"status": "not_paused"`; an un-paused role that `resume` reports as not paused still cannot be admitted by that reason. Two commands settle it honestly while the round still says `paused`: `config unset bootstrap` makes the identical `--once --role readme` command report `runs: 1`, and `wake --role readme` (bootstrap still active, header still reads `bootstrap: 0/5 plans done`) also makes it report `runs: 1` — so the hold is bootstrap, not a pause, and `wake` is the lever the report never names.
  The prose form of a round on this repo ends `once: 1 run — 1 no_change, 25 skipped (no free entry, no free entry, …, paused, paused, …, backoff)` — one bare reason word per skip, bootstrap holds indistinguishable from pauses.
- **Suspected cause:** `settleOncePaused` in `src/scheduling/skip.ts` settles four different holds with the one `paused` reason — a role's own cost cap (`capPaused`), the maintenance quota over-line, `bootstrapHeldNow`, and an operator pause (`operatorPauseBlocks`). Only the last is a pause and only the last is liftable by `resume`; the other three read as `paused` and are lifted by something else entirely. The status side already keeps them apart (`status-data.ts` carries `capPaused`, `maintenanceQuota`, `bootstrapHeld` and the pause set as separate fields, and `status-model.ts` renders a held role as `waiting: bootstrap`), as does the event feed's bootstrap hold message — so only the `--once` report flattens them.
- **Expected / fix sketch:** name the hold in the skip record the way the status payload names it — `"reason": "held: bootstrap"`, `"held: maintenance quota 3/2"`, `"budget paused"` — keeping plain `paused` for what `resume` actually answers. A `--json` consumer branching on `reason === "paused"` gets the wrong branch for every held role on a fresh project, so pin the labels in the `--once` skip test alongside the existing `no free entry` / `backoff` reasons (BUGS-FIXED.md's 2026-10-12 "Idle loops say why they are idle" entry asked for the same distinction on the dashboard side and landed it there).

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
- 2026-11-17 run (real): fresh build of worktree tip 1fc125aa + `init` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` (the free no-login OpenCode tier) + `start --once --role feature --json` — exactly one real run on opencode's free DeepSeek, a `no_change` round (943 tok, $0.00, ~51s), exit 0, clean `orchestrator_start`/`stop` with no leaked process; `status` feature row (1 run, $0.00, `no change`) + the documented `No build check declared` alert + the 16-row role table all match README/docs, and `logs` confirms `run #1 started on opencode/deepseek-v4.1-flash-free` → `no change · 943 tok`.
