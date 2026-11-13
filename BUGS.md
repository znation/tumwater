# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### The backlog range reader (actionableEntryRanges) reads only `### ` headings, so `- `-bullet entries are invisible to the closed-entries index, the archive dedupe, and the bug wait-close

**Symptom.** `actionableEntryRanges` (src/backlog/backlog-index-data.ts, `line.startsWith("### ")` is the only entry-start test) is the shared entry reader for twelve modules, yet it recognizes only `### ` headings. The canonical reader `parseEntryDetails` (src/backlog/backlog-md.ts) and the date reader `eachEntryStart` (backlog-md.ts:359) both read `### ` headings AND `- ` bullets as entry-starts, and the team's roles compress most closed bugs into single-line `- ` bullets — BUGS-FIXED.md's `## Fixed` holds 1914 `-` bullets against 491 `###` headings. So the range reader is blind to the archive's majority shape.

**How to reproduce (offline, deterministic).** A scratch import over this tree: `actionableEntryRanges(BUGS-FIXED.md, "Fixed")` returns 1 range (a single `###` entry at line 43) out of 1914 bullets + 491 headings; the real newest closed entries (the `-` bullets at lines 8/20/30/…) are all skipped. Consequence 1 — the `<backlog-index>` block's `BUGS-FIXED.md ## Fixed (newest N)` (backlog-index.ts renderClosedSections, RECENT_CLOSED_MAX 5) lists stale `###` entries and never the actual newest closed bugs, in every role prompt. Consequence 2 — the archive dedupe (backlog-archive.ts entryFates, via entriesIn→actionableEntryRanges) matches selected entries against the archive's `###` entries only, so it cannot recognize a closed bug the archive already holds as a `-` bullet and will re-move it (duplicate). The same reader powers recordRecurrence (backlog-file-bugs.ts) and closeQuietWaitsText (backlog-bug-waits.ts).

**Suspected cause.** The `-` bullet is a valid one-line entry shape (parseEntryDetails and eachEntryStart read it; the team uses it for compressed closed entries), but the range walk was written for `###` headings only and never extended to the bullet shape, so every consumer of the range reader inherits the blind spot.

**Required behavior.** Decide the canonical entry shape for one-line entries and make the range reader match it. The fork: (a) make `actionableEntryRanges` read a top-level `- ` bullet as an entry-start (matching parseEntryDetails/eachEntryStart) so the closed index, archive dedupe, and bug wait-close all see the majority archive shape — the open `## Open` shape then needs a guard so a `- ` repro step inside an entry body is not misread as a sibling entry, or (b) canonicalize one-line entries to `### ` in the archive and close paths so the `###`-only reader is never blind. This is a plan-role design call (it touches twelve call sites and the entry-shape contract); the bugfix role records it, not force-picks a shape.

- The live-orchestrator e2e `a reached cap switches roles to the free fallback model instead of stopping them` (test/orchestrator-budget.e2e.test.ts:210) flakes on a near-bar host — it passed the quiet-host gate, then timed out at its 150 s role-run-spawn wait (found by the ci role 2026-11-12).

**Symptom.** At main tip `aa80aa1`, the first full e2e run (`npm run test:e2e`) failed this one test: `timed out waiting for a role run after the cap was reached` at 150406 ms — the `waitFor(..., 150_000)` at test/orchestrator-budget.e2e.test.ts:259. The test's own `awaitQuietHost` gate had passed — the 1-minute load was below the 18-core count, so the gate admitted it — while the host's 5/15-minute averages were still elevated (≈10–14): a near-bar host whose 1-minute value had dipped below the count was still saturated on the longer timescale, and the wall-clock spawn wait stretched past its budget. The single test passed in isolation (889 ms) and a full e2e re-run at the same tip was green (87/87, 0 skipped), so it is a load-sensitive flake, not a regression. `npm test` was fully green (0 fail) at the tip, and the remote CI run it judges (de73863) was already passing, so nothing on the hosted runner is red.

**Required behavior.** The post-cap-switch role-run spawn settles within its wall-clock budget on a host whose 1-minute load is below the core count but whose sustained (5/15-minute) load is still high. The concrete seam: the gate (test/helpers/wait.ts `awaitQuietHost`) treats `load1 <= cpus` as quiet and `load1` is `os.loadavg()[0]` (the 1-minute average); a near-bar host whose 1-minute value dips below the count while its 5/15-minute average is still elevated is admitted and then starves the 150 s spawn wait. Either the gate should sample the longer average (or defer when it is still high), or this wait should be driven on the fake clock like the watchdog tests. The recurrence landed on 2026-11-12 AFTER the per-test quiet-host gate and the 150 s robustification were already in the tree, so it is the documented load-flake class recurring despite those robustifications, not a regression.

**Validation gap:** no-repro — the flake reproduces only under sustained shared-host load; verified the tip green after the load subsided.

## Fixed

- A stale or dangling merge pin that leftover recovery drops leaves its in-flight marker record
  behind, so the status surfaces show a phantom `merging` row forever (the true root cause of the
  "stale marker beside a stale pin" e2e flake, previously misdiagnosed as host load) — fixed
  2026-11-12 by the operator (release cut).

**Symptom.** `test/orchestrator-3.e2e.test.ts` "a stale marker beside a stale pin is dropped at
the drain without a merge run" intermittently timed out (`timed out waiting for the stale pin to
be dropped and its marker cleared`) even on a quiet host at the 150 s budget, and CI failed on
it twice. A hand-run repro parsed the residue: the merge ref was absent (the pin WAS dropped) but
the stale marker file still existed, so the wait (both absent) never held.

**Suspected cause.** The pin-queue rework (68ca5115f) added marker clearing on the *drain's* drop
of a stale/dangling pin but missed the *author's leftover recovery* drop (`recoverLeftover`),
which shares `dropStalePin`/`dropDanglingPin`. When the author's run starts in the window between
`merge_done` and the merge task's finally releasing the slot (postReviewDue awaits git there), its
recovery drops the stale pin without clearing the marker; the drain's `refAbsentFromFiles`
fast-path then skips the runner (no pin) and the marker is never cleared. The 2026-11-11 bugfix
(23b74d9df) misread this as load: it added a quiet-host gate and widened the deadline, which the
post-merge review of that very commit never reached a verdict for.

**Fixed.** `recoverLeftover` now clears the role's marker record (`removeMergeChange`) when it
drops a stale or dangling pin — the same drop-site clearing the drain does. A regression test in
`test/runner-leftover.test.ts` pins the marker is cleared on both drops; the e2e test passes
repeatedly with the fix and the marker-leak repro no longer holds.

**Validation gap:** the e2e failure was timing-dependent (recovery-vs-drain race), so it could
not be reproduced on demand; the deterministic unit tests cover the drop path directly, and a
5× repeat of the e2e test is green with the fix.

- The post-merge review of `23b74d9df` never reached a verdict; reviewed by hand on the release
  cut and closed — the commit's only code change was the quiet-host gate + widened deadline for
  the stale-pin e2e test, a misdiagnosis of the marker leak above (now fixed at the root).
