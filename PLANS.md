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

### `sectionSpan`'s fence-aware section boundary is pinned in test/backlog.test.ts, so a regression in the one fence-aware home of a `## ` section's span the backlog writers (backlog-write.ts) and the archive mover (backlog-archive.ts) both read through — the heading a `## <title>` section opens at, and the next real `## ` heading that ends it — is caught by the suite (planned 2026-11-16 by the plan role; continues the pin-a-rule family — the recent `roleInScope` (test/roles.test.ts, above), `lowerMedian`, `compareCodeUnits`, `validEntries` entries each take one correct-but-unpinned single-home rule and pin it in its natural test file with plain `assert`. `sectionSpan(lines: readonly string[], title: string)` in src/backlog/backlog-md.ts returns the 0-based span `{ heading, end }` of the FIRST `## <title>` section — its heading line, then `nextSectionHeading`'s walk to the next real `## ` heading (or `lines.length`) — or `null` when no such section exists. It reads every line through the shared fenceTracker, so a `## ` line quoted inside a fenced code block is body text, never a section boundary. `grep -rlw sectionSpan test/` is empty — no test file references it. Its fence branch is genuinely unpinned: its only src consumers are the writers, and neither `test/backlog-archive.test.ts` (0 fenced blocks) nor a write test feeds a section whose boundary is quoted inside a fence. The two sibling fence-aware section readers are already pinned transitively and are NOT this entry's target — `fenceAwareHeadingLines`'s consumers (`duplicateHeadings`, `actionableEntryRanges`) have fenced-heading tests in test/backlog-structure.test.ts, and `sectionBodyLines`'s consumer (`strandedPlanEntries`) has a fenced-`## Planned` test there; pinning them again would add a duplicate. The flip a regression would silently make: read the heading line without the fence guard (or drop `fencedHeadingTitle`) and a `## Done` quoted inside a fenced entry is mistaken for the archive's real `## Done` heading — or, reading the end boundary without the guard, cuts the section at a quoted `## Fixed`, so the archive mover ships the wrong lines — done 2026-11-16 by the feature role

**Goal.** Pin the one fence-aware section reader the backlog writers read through — `sectionSpan` — in `test/backlog.test.ts`, the file that already hosts the fence-reading tests (`fenceTracker`, `fenceOpener`, `closesFence`) and imports from `../src/backlog/backlog-md.js`.

**Approach.** One file, no new dependency, no src change, no invariant edit. In `test/backlog.test.ts` add `sectionSpan` to the existing `../src/backlog/backlog-md.js` import and add one `test(…)` block named for the rule (e.g. `"sectionSpan finds a ## section's span, fence-aware"`), with plain `assert` cases whose expected values are worked from the `fencedHeadingTitle`/`nextSectionHeading` bodies in src/backlog/backlog-md.ts, not from calling the function — `sectionSpan` takes a `string[]`, so each case is `sectionSpan([...lines], "<title>")` against a `assert.deepEqual` of the exact `{ heading, end }` or `null`:
- a quoted `## <title>` inside a fence is not the section, and a later real `## <title>` is: `sectionSpan(["## Done", "", "x", "```md", "## Done", "```", "", "## Fixed", "y"], "Done")` is `{ heading: 0, end: 7 }` — the fence is open at line 4, so the quoted `## Done` (line 4) is body text and never the heading; the real heading is line 0 and the end is the real `## Fixed` at line 7.
- a `## <title>` whose only occurrence is fenced is absent: `sectionSpan(["## Open", "", "```", "## Done", "```", "", "## Fixed", "y"], "Done")` is `null` — the sole `## Done` is a quoted line inside the fence, so the section does not exist.
- a plain (unfenced) section still resolves: `sectionSpan(["## Open", "a", "", "## Done", "b", "", "c"], "Done")` is `{ heading: 3, end: 7 }` — the non-fenced rule still works, so the fence branch is a special case, not a rewrite.
- a section that runs to EOF: `sectionSpan(["## Done", "x", "y"], "Done")` is `{ heading: 0, end: 3 }` — `nextSectionHeading` returns `lines.length` when no later `## ` heading follows.
- a missing section: `sectionSpan(["## Open", "", "## Done"], "Missing")` is `null`.

Each expectation is read from `fencedHeadingTitle` (a `## ` line inside a fence returns `null`, so it is neither a heading nor a boundary) and `nextSectionHeading` (returns the next real `## ` index, or `lines.length`), not from a call to `sectionSpan`; the quoted-in-a-fence cases are the fence contract the pin asserts.

**Files touched.** `test/backlog.test.ts` only — add `sectionSpan` to the existing `backlog-md.js` import and add the one test block. No `src/` file changes; no `docs/invariants.md` edit (no section-boundary section binds `sectionSpan`).

**Acceptance criteria.**
- The new test in `test/backlog.test.ts` passes on the current tree.
- A regression that read the `## ` heading or the section end boundary WITHOUT the fence guard fails the new test on the quoted-`## Done`-inside-a-fence cases (`{ heading: 0, end: 7 }` and the `null` case).
- The plain-section and EOF cases pin that the fence branch is a special case: an unfenced `## Done` still resolves to `{ heading: 3, end: 7 }` and a section with no following heading ends at `lines.length`.
- The pin does NOT add a duplicate of the two sibling readers' existing coverage: it tests `sectionSpan` only (not `fenceAwareHeadingLines` or `sectionBodyLines`, whose fence branches their consumers' tests already exercise).
- No `src/` file, `docs/invariants.md` line, or other test file changes — the change is confined to `test/backlog.test.ts`.
