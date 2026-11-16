# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. The
harness renders it read-only; the roles that act on it are plan (adds and retires `## Planned`
entries), feature (claims, completes, refuses, and reports plan defects on `## Planned`), and bugfix
(claims, fixes, and refuses `## Open`). Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

### `takesSalvagedWork`'s salvage-presence gate is pinned in test/run-resume.test.ts, so a regression in the one home of "does this run's plan carry salvaged work" the resume path (run-resume.ts) and the run gate (runner-run.ts:428) both branch on would be caught at the gate rather than as a resume that silently drops a conflict-restored patch (planned 2026-11-16 by the plan role; retires the pin-a-rule slot left by the stranded-done `sectionSpan` entry)

`takesSalvagedWork` (src/run/run-resume.ts) has **no direct test** anywhere, and its only indirect
cover is one arm: the salvage-true branch. Its consumer test `test/runner-salvage.test.ts` drives
the true arm only — `resume.cause === "salvaged"` → `takesSalvagedWork` true → `planWithSalvagedWork`
runs → a handoff prompt with the patch path is observed. The two **false** arms — a plan whose
`prompt` is non-null, and a plan with a `userPrompt` — are unexercised on the exact output: the
other runner tests that pass through the gate build their plans via the full plan path and never
assert the gate's own decision, so a flip in either false arm (say, the `&&` becoming `||`, or a
null-coalescing typo) would let `planWithSalvagedWork` run on a plan that has no salvaged work and
append a phantom "resumed from a conflict-restored patch" handoff to an ordinary run — the L23 bar
(0 direct refs and not transitively covered on the multi-branch input) is met.

- **Approach**: in test/run-resume.test.ts, add `takesSalvagedWork` to the existing import from
  `../src/run/run-resume.js` and pin all three arms of the predicate against a minimal
  `RunStartPlan` stub. Exact expected values (hand-computed from the `plan.prompt !== null &&
  plan.userPrompt === null` source, confirmed against the compiled `dist/`): a plan with
  `prompt: "some text"` and `userPrompt: null` → `true`; a plan with `prompt: null` and
  `userPrompt: "some text"` → `false`; a plan with `prompt: null` and `userPrompt: null` → `false`.
  Each arm asserts the boolean directly.
- **Acceptance criteria**:
  - test/run-resume.test.ts passes with the three cases above.
  - One of the three cases would fail if the `&&` in `takesSalvagedWork` were changed to `||`
    (the `prompt: null` / `userPrompt: "some text"` case returns `true` under `||`).
  - `npm run test:gate` passes.

### `isMergeClaim`'s fail-closed shape rejection is pinned in test/commit-message.test.ts, so a regression in the one home of "is this a valid merge claim" the SUMMARY/WHY/RISK/VERIFIED builder (buildMergeSummary) relies on to refuse a claim it cannot attribute would be caught at the gate rather than as a commit whose trailer names an entry the queue does not know (planned 2026-11-16 by the plan role; retires the pin-a-rule slot left by the stranded-done `sectionSpan` entry)

`isMergeClaim` (src/runner/commit-message.ts) has **no direct test** — its only references are in
its consumer `buildMergeSummary` (same file) and that consumer's tests, which exercise the
valid-claim path (a correctly-shaped key passes through to the trailer) but never the two
fail-closed rejections. It is a genuine 3-arm predicate: a `PLANS.md` claim whose key is not a
series part or a bug index is refused, a `BUGS.md` claim whose key is not a bug index is refused,
and any other file is refused. The L23 bar (0 direct refs and not transitively covered on the
multi-branch input) is met: a consumer test never feeds a malformed key and asserts the exact
rejection string. A regression that loosens either shape check (say, dropping the `part`/`N/M`
alternation, or the file dispatch) would let a mislabeled claim through to a commit trailer, where
the merge queue then attributes work to an entry that does not exist — a silent bookkeeping rot the
fail-closed string is the only guard against.

- **Approach**: in test/commit-message.test.ts, add `isMergeClaim` to the existing import from
  `../src/runner/commit-message.js` and pin all three arms against a minimal claim stub
  (`{ file, key, title, description, why, risk, verified }`). Exact expected values (hand-computed
  from the source's three template strings, confirmed against the compiled `dist/`): a `PLANS.md`
  claim with key `"part 1/2"` and title `"Add X"` → the string `PLANS.md files "Add X" as "part
  1/2" — claims must name an entry ("Fix the <kind> plan or bug")`; a `BUGS.md` claim with key
  `"1/2"` and title `"Fix Y"` → the analogous `BUGS.md files "Fix Y" as "1/2" — …` string; a
  `README.md` claim with key `"1/2"` and title `"Doc Z"` → `README.md has a claim that is not for
  a plan or a bug`; and a `PLANS.md` claim with a correctly-shaped series-part key (per the regex
  `/^[A-Za-z][A-Za-z0-9]*(?: [A-Za-z0-9]+)* (?:part \d+\|\d+|\d+\/\d+)$/`) → `undefined`.
- **Acceptance criteria**:
  - test/commit-message.test.ts passes with the three fail-closed cases and the one valid case.
  - The two fail-closed cases quote the exact template strings above (the text is the contract the
    operator reads).
  - `npm run test:gate` passes.

## Done
