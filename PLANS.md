# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### `distinctOrdered`'s skip-a-repeat / first-seen-order rule is pinned in test/collections.test.ts, so a regression that lets a repeated element leak through — or reorders the surviving elements — is caught by the suite (planned 2026-11-15 by the plan role; `distinctOrdered<T>(items: Iterable<T>): T[]` in src/collections.ts is the one home of the "keep the first occurrence of each distinct element, in the order first seen, dropping later repeats" step its ~27 call sites share — src/ui/tui/tui-pane-session.ts's base-role list, tui-pane-pending.ts's overlap + entry role lists, tui-pane-activity.ts's present event types, src/gates/startup-gates.ts's in-use agents, src/doctor/doctor-orphans.ts's descendant + pid lists, doctor-backlog.ts's watched file set, src/baseline/main-watch.ts's known-failure list, src/cli/cli-operator-commands.ts's named-role lists, cli-completion.ts's command / key / path-flag lists, cli-help.ts's did-you-mean candidates, src/failure/failure-data.ts's delta roles, src/report/report-fold.ts's base roles, and src/text/text.ts's comma-list + token lists — so a drift in how a repeat is skipped would move a repeated role, file, pid, or token into every one of those surfaces. Its siblings in the same file are each pinned in test/collections.test.ts — `getOrCreate`, `groupBy`, `rankCountEntries`, `sortByValueDesc`, `addTo`, `memoSetLru`, `topAndHidden` — but `distinctOrdered` is the one with no direct unit pin: `grep -rn --include='*.test.ts' distinctOrdered test/` prints nothing, and no prior entry in PLANS-DONE.md pins it. It is genuinely multi-branch and its own rule, not a 1-line composition over a pinned fn: `const seen: T[] = []; for (const item of items) if (!seen.includes(item)) seen.push(item); return seen;` — the `includes`-guarded `push` is the whole dedup, and the first-seen ordering falls out of the forward `for` rather than a sort. No consumer test asserts it today: the TUI panes that feed it repeated role ids have no test file, doctor-backlog's watched set is a static file list whose order is irrelevant to the `git status` call, and failure-data's delta roles never receive a role in both windows in any test — so a repeat leaking through (a dropped `includes` guard) or a reorder (a stray `.sort()`) would be caught by nothing. The pin is test-only: no source change, and docs/invariants.md binds no collections.ts symbol to a guarantee, so no invariant edit is needed)

**Goal.** Pin `distinctOrdered`'s dedup + first-seen-order rule so a regression is caught: a repeated element must not leak through, and the surviving elements must keep the order in which they were first seen.

**Approach.** Extend test/collections.test.ts (which already pins the rest of src/collections.ts): add `distinctOrdered` to its `../src/collections.js` import and add node:test cases driving the function directly. No source change to src/collections.ts. (The same file's `rankByCount` is *not* part of this plan: its count-descending rule is already consumer-pinned by test/failure-time-spend.test.ts's "rows rank by summed wall-clock ms, roles tie-broken by name" case, so pinning it would be a re-cover of a pinned rule, not a new one.)

**Files touched.** test/collections.test.ts (import + ~4 cases). src/collections.ts is read to confirm the rule, not modified.

**Acceptance criteria.**
- Given `["a", "b", "a", "c"]`, `distinctOrdered` returns `["a", "b", "c"]` — the repeat at index 2 is dropped and the first occurrence is kept.
- Given elements whose first occurrences are out of alphabetical order (e.g. `["c", "a", "b", "c"]`), the result is `["c", "a", "b"]` — first-seen order is preserved, not re-sorted.
- A list with no repeats (e.g. `["x", "y", "z"]`) is returned as a fresh array holding all of them in input order, and the input array itself is left unmutated (the caller's reference is unchanged; a length/contents check on the original confirms it).
- Given an empty input, it returns an empty array.

## Done
