# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

_None yet._

### `checkMinRunInterval`'s numeric-range rule is pinned in test/config-keys.test.ts, so a regression in the one home of the min-run-interval screen the per-key writers run before a write — the rule that keeps a non-numeric, negative, or over-bound interval from being flashed as a bare shape message by the TUI interval editor and the dashboard role-interval endpoint — is caught by the suite (planned 2026-11-15 by the plan role; `checkMinRunInterval(value, key)` in src/config/config-keys.ts is the per-key value validator the TUI interval editor (src/ui/tui/tui-editor-interval.ts) and the dashboard role-interval endpoint (src/gui/gui-config-commands.ts) run before a write, returning `` `${key} must be a number of 0 or more, at most ${MAX_DURATION_SECONDS} (got ${show(value)})` `` for a non-number / non-finite / negative / over-bound value and `null` otherwise — its 0-or-more, at-most-`MAX_DURATION_SECONDS` rule is its own, read from the `MAX_DURATION_SECONDS` constant in src/config/config-field-checks.ts, so it is not a composition over a pinned fn; it is untested — `grep -rn --include='*.test.ts' checkMinRunInterval test/` matches only a `//` comment in test/gui-endpoints.test.ts, and test/config-keys.test.ts does not exist; the whole-config `roles.<id>.minRunIntervalSeconds` path is validated separately through `DURATION_NON_NEGATIVE` in test/config-validation.test.ts, a different key and a different function, so it does not cover this guard; independent of the other `## Planned` entry, which pins src/config/config-selector-checks.ts through test/config-selector-checks.test.ts — these pin src/config/config-keys.ts through test/config-keys.test.ts, and the two share no src module, test file, or named import — so feature may take either; docs/invariants.md binds no invariant to this guard's guarantee through a test, so no invariant edit is needed)

**Goal.** Pin the one unpinned member of the per-key value-validator family in src/config/config-keys.ts. `checkMinRunInterval` is the single home of the rule that decides whether an interval value is acceptable before a write: a finite number of 0 or more, at most `MAX_DURATION_SECONDS` (the `×1000` setTimeout bound the config duration rules share). Both write surfaces that name a min-run-interval key — the TUI interval editor and the dashboard role-interval endpoint — run it, and a value that fails is flashed to the user with its returned message, so that message wording is the observable contract. Its two siblings in the file, `checkDailyBudgetUsd` and `checkQuietHours`, are already exercised end-to-end through `config set` and the GUI; `checkMinRunInterval` is the one with no test of its own, and no test drives it directly. Pin its branches with plain `assert` on the exact strings it returns, in a new test file.

**Approach.** One file, test-only, no src change and no invariant edit: create test/config-keys.test.ts importing `checkMinRunInterval` from `../src/config/config-keys.js` and drive each branch in isolation, each case one `assert.equal` (the values are rendered through `show()`, so non-finite numbers spell out as `NaN` / `Infinity` and everything else appears JSON-quoted — quote them exactly, they are the contract the surfaces flash). Drive the `key` default (the team-wide `minRunIntervalSeconds`) and one explicit `key` to pin that the named key renders in the message. No repo, worktree, fs, git, or clock.

**Files touched.** test/config-keys.test.ts (new).

**Acceptance criteria.**
- Given a finite number of 0 or more within the bound — `60`, `0`, `1`, and the boundary `2147483` (`MAX_DURATION_SECONDS`) — `checkMinRunInterval(v)` returns `null`.
- Given a value one past the bound, `2147484`, `checkMinRunInterval(2147484)` returns `` minRunIntervalSeconds must be a number of 0 or more, at most 2147483 (got 2147484) ``.
- Given a negative number, `checkMinRunInterval(-1)` returns `` minRunIntervalSeconds must be a number of 0 or more, at most 2147483 (got -1) ``.
- Given a non-finite number, `checkMinRunInterval(NaN)` returns `` minRunIntervalSeconds must be a number of 0 or more, at most 2147483 (got NaN) `` and `checkMinRunInterval(Infinity)` returns `` minRunIntervalSeconds must be a number of 0 or more, at most 2147483 (got Infinity) `` — a non-finite value is spelled out, not `null`.
- Given a non-number, the returned message names the JSON-quoted value, or `missing` for `undefined`: `checkMinRunInterval("60")` returns `` minRunIntervalSeconds must be a number of 0 or more, at most 2147483 (got "60") ``, `checkMinRunInterval(null)` returns `` minRunIntervalSeconds must be a number of 0 or more, at most 2147483 (got null) ``, `checkMinRunInterval(undefined)` returns `` minRunIntervalSeconds must be a number of 0 or more, at most 2147483 (got missing) ``.
- Given an explicit key, `checkMinRunInterval(-1, "roles.feature.minRunIntervalSeconds")` returns `` roles.feature.minRunIntervalSeconds must be a number of 0 or more, at most 2147483 (got -1) `` — the named key (not the default) leads the message, matching what the dashboard endpoint and the TUI editor flash for a role's key.
- Every pre-existing test passes unmodified; no source file and no other test file change; the project's declared check is green.

## Done
