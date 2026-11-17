# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. The
harness renders it read-only; the roles that act on it are plan (adds and retires `## Planned`
entries), feature (claims, completes, refuses, and reports plan defects on `## Planned`), and bugfix
(claims, fixes, and refuses `## Open`). Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

### `isFullCheckScope`'s `full === false` arm is pinned in test/build-check-events.test.ts, so a regression in the one home of "does this build_check event count as a full check?" — the arm the main-check badge (status-main-check.ts's `mainCheckForPoll`) and the report's check row rely on to NOT count a merge or batch run of the cheaper `check.mergeCommand` as a full-suite verdict — would be caught at the gate rather than as a cheap merge command badgeing main and folding a red into the report (planned 2026-11-16 by the plan role; the pin-a-rule for the `full` flag the sibling `scope` arms leave unpinned)

`isFullCheckScope` (src/build/build-check-events.ts) has **no direct test**. Its two consumers are
the main-check badge scan `mainCheckForPoll` (src/status/status-main-check.ts, which selects the
last full check from `build_check` events) and the sibling predicates `isPassingFullCheck` /
`isRedFullCheck` (same file) that the doctor's check row and the report's usage fold apply. The
scope arms are already transitively covered — `build-check-events.test.ts`'s `isPassingFullCheck` /
`isRedFullCheck` tests feed a `full`-less event for each scope and pin merge/batch/baseline → full,
gate → not — but neither test ever sets the `full` field, so the guard's `full === false` arm (a
merge or batch run of `check.mergeCommand` is never a full-suite verdict whatever its scope) is
unpinned: a regression that drops the `if (full === false) return false` early return would let a
cheap merge-scope command read as a full check — badgeing main and folding a red into the report's
check row — and no existing test catches it. The L23 bar (0 direct refs and an arm the consumers
leave unpinned) is met by that `full === false` arm.

- **Approach**: in test/build-check-events.test.ts, add `isFullCheckScope` to the existing import
  from `../src/build/build-check-events.js` (the file already imports `isPassingFullCheck` and
  `isRedFullCheck` from the same module) and pin the `full` flag directly, hand-computed from the
  guard (`full === false` → `false`; else `scope` in `"merge" | "batch" | "baseline"` → `true`;
  else `false`): `isFullCheckScope("merge", false)` → `false` (the cheap merge command is not a
  full verdict); `isFullCheckScope("batch", false)` → `false`; `isFullCheckScope("merge", true)` →
  `true`; `isFullCheckScope("baseline", true)` → `true`; `isFullCheckScope("gate", true)` → `false`;
  and a `full`-less event `isFullCheckScope("merge", undefined)` → `true`. Each case asserts the
  boolean directly.
- **Acceptance criteria**:
  - test/build-check-events.test.ts passes with the cases above.
  - The two `full: false` cases return `false` even though their scope is in the full set, and would
    fail if the guard dropped its `if (full === false) return false` arm.
  - The `gate, true` case returns `false` (a gate check can run a subset, so it is not a full
    verdict), and the `merge, true` and `merge, undefined` cases return `true`.
  - No other `## Planned` or archived `## Done` entry already pins `isFullCheckScope`
    (`grep -rn isFullCheckScope test/` prints nothing; the only test references are the two
    consumer predicates, whose scope arms this entry does not replace).
  - `npm run test:gate` passes.

## Done
