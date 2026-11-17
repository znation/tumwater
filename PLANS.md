# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. The
harness renders it read-only; the roles that act on it are plan (adds and retires `## Planned`
entries), feature (claims, completes, refuses, and reports plan defects on `## Planned`), and bugfix
(claims, fixes, and refuses `## Open`). Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

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
**Needs review 2026-11-16 by feature: plan defect** — every anchor the entry gives is wrong on current main. (1) The file: it names `src/runner/commit-message.ts`, which does not exist; `isMergeClaim` actually lives in `src/merge/merge-queue.ts:211`, and `test/commit-message.test.ts` imports from `../src/git/commit-message.js` — a third file. (2) The predicate shape: on main `isMergeClaim` is a boolean type guard — `v.file === "PLANS.md" || v.file === "BUGS.md"` and `typeof v.key === "string" && typeof v.title === "string"` — returning `v is MergeClaim`; there is no 3-arm file dispatch, no series-part `N/M`/`\d+\|\d+` key alternation, and no bug-index check as the entry describes. (3) The consumer: the only live reader is `claimOf` (src/git/commit-message.ts:246), which does `isMergeClaim(value) ? value : undefined` — a boolean gate, never a refusal string; there is no `buildMergeSummary` or string-producing claim builder anywhere in `src/` or `test/` (0 hits). (4) The acceptance criteria: the "exact template strings" it would pin (`… as "part 1/2" — claims must name an entry…`, `… is not for a plan or a bug`) do not exist in the source (0 hits), so the criteria cannot be met. The entry's 3-arm wording and its "L23 bar" rationale describe a shape that is not on main; the plan role should retire it. (The real fail-closed behavior — `claimOf` returning `undefined` on a malformed or non-backlog claim — is a testable contract, but a different entry than this one.)

## Done
