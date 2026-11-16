# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### `roleInScope`'s direct-or-through-base membership is pinned in test/roles.test.ts, so a regression in the one home of the instance-aware role-scope filter the `logs --role`/`-n`/`--role` view filters, the merge-queue's role scope, and the status snapshot's `scopeSnapshotToRoles` all read through — a scope that names a base id also matches that base's instance ids — is caught by the suite (planned 2026-11-16 by the plan role; continues the pin-a-rule family — the recent `lowerMedian` (test/collections.test.ts, done+archived), `compareCodeUnits`, `validEntries`, `filterKeepPositions`, `setOwn`, `checkMinRunInterval`, `isPlainDecimal`/`isExponentSpelling` and `fallback`-chain entries each take one correct-but-unpinned single-home rule and pin it in its natural test file with plain `assert`. `roleInScope(id: string, scope: readonly string[]): boolean` in src/roles/runner-ids.ts is `scope.includes(id) || scope.includes(baseRoleOf(id))` — a membership test whose second arm folds an instance id (`feature-2`) to its base role (`feature`) before the scope check, so a scope naming the bare base also matches the instances. It is exported from the one home the three filters read, and no test file references it — `grep -rlw roleInScope test/` is empty. Its base fold, `baseRoleOf` (`feature-2`, `bugfix-10`, … → their base; `plan-2`, a custom id, or any other non-`feature`/`bugfix` `-N` id → unchanged), is pinned by the done+archived `commitTier` entry in the same file (test/roles.test.ts), so the pin adds `roleInScope` and needs no src change. The flip a regression would silently make: drop the `|| scope.includes(baseRoleOf(id))` arm and every instance id stops matching a scope that named only its base, so a scope of `["feature"]` no longer takes `feature-2` — the doc comment's own promise. No `docs/invariants.md` section binds a role-scope filter, so no invariant edit; touches test/roles.test.ts only. Independent of the family (a different rule, same test file — the same import-list extension shape each entry takes)

**Goal.** Pin the one unpinned instance-aware membership rule in `test/roles.test.ts`. `roleInScope` is the single home of the "a scope naming a base id also matches that base's instances" contract the logs/views filters, the merge-queue role scope, and the status snapshot all read, and its second arm — the `baseRoleOf` fold — is a genuinely multi-branch membership test no test references.

**Approach.** One file, no new dependency, no src change, no invariant edit. In `test/roles.test.ts` (which imports the role-catalog exports from `../src/roles/roles.js` and pins `commitTier`, whose instance-id cases exercise `baseRoleOf` transitively), add an import of `roleInScope` from `../src/roles/runner-ids.js` and add one `test(…)` block named for the rule (e.g. `"roleInScope matches an id directly or through its base role"`), with plain `assert` cases whose expected values are worked from the rule in src/roles/runner-ids.ts, not from calling the function:
- the direct arm: `roleInScope("feature", ["feature"])` is `true`, and `roleInScope("feature", ["bugfix"])` is `false` — an unrelated base id is not in scope.
- the instance fold through the base (the flip guard): `roleInScope("feature-2", ["feature"])` is `true` — only the second arm matches, since the scope holds the bare `feature`, not `feature-2`; a scope that named the instance directly also holds, `roleInScope("feature-2", ["feature-2"])` is `true`.
- the non-instance `-N` id does NOT ride the base: `roleInScope("plan-2", ["plan"])` is `false` — `plan` is not a `feature`/`bugfix` instance, so `baseRoleOf` returns `plan-2` unchanged and neither arm matches a scope that holds only the bare `plan`; the contrast against the true instance fold above is what pins that the fold applies only to `feature`/`bugfix` instances.
- an empty scope matches nothing: `roleInScope("feature", [])` and `roleInScope("feature-2", [])` are both `false`.

Each expectation is read from the `scope.includes(id) || scope.includes(baseRoleOf(id))` body and the `INSTANCE_ID_SOURCE` regex in src/roles/runner-ids.ts, not from a call to `roleInScope`; the instance-vs-non-instance contrast is the contract the pin asserts.

**Files touched.** `test/roles.test.ts` only — extend its imports (add `roleInScope` from `../src/roles/runner-ids.js`) and add the one test block. No `src/` file changes; no `docs/invariants.md` edit (no role-scope-filter section).

**Acceptance criteria.**
- The new test in `test/roles.test.ts` passes on the current tree.
- A regression that dropped the `|| scope.includes(baseRoleOf(id))` arm fails the new test on the `roleInScope("feature-2", ["feature"])` is-`true` case.
- A non-instance `-N` id (`plan-2`) is asserted `false` against a scope naming only the bare base (`plan`), pinning that the instance fold applies only to `feature`/`bugfix` instances.
- No `src/` file, `docs/invariants.md` line, or other test file changes — the change is confined to `test/roles.test.ts`.

## Done
