# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### A live-orchestrator e2e pin-drain test flakes on a loaded host — `a pin surviving a restart drains through the gate on next start` (test/orchestrator-3.e2e.test.ts:184) fails when the shared host is starved, though it passes isolated (found by the ci role 2026-11-15)

**Symptom.** On a full `npm run test:e2e` against main tip 91650da, this test failed once in the tier (`ℹ fail 1`): it seeds a survivor pin — one commit pinned by the merge ref, no queue entry, the crash-between-commitAll-and-pin-write state — starts a live orchestrator, waits for the pin to drain onto main, then asserts the `merge_done` count is 1. On the loaded host the drain never landed within the `waitFor` deadline, so the count stayed 0 and `assert.equal(eventsOfType(repo, "merge_done").length, 1, "the surviving change merged through the gate")` (line 207) failed: `0 !== 1`.

**How to reproduce.** Run `npm run test:e2e` (the whole e2e tier) on a shared host under heavy load. On the 18-core host at load1 44.9 / load5 30.6 (2.5× saturated) the 100 ms live-orchestrator poll cycle stretched and the unguarded pin-drain test missed its deadline; in that same run its load-gated sibling (`a stale marker beside a stale pin…`, line 273) correctly `t.skip`ped via `awaitQuietHost`. Re-run the single file in isolation on the same host once load dropped to ~4: `node dist/test/test-runner.js orchestrator-3` → 11 pass / 0 fail / 0 skip, the pin-drain test green in 413 ms. A full-tier re-run on the calmer host (load1 ~1.3): 87 pass / 0 fail / 0 skip. So the failure is load-sensitive, not a regression — the code drains the pin correctly when it is not starved.

**Suspected cause.** The test has no quiet-host gate of its own — it relies on the default `waitFor` deadline, which the stretched poll cycle under host load pushes the drain past, exactly the near-bar case the load-gated sibling's comment describes.

**Required behavior.** Gate this test the way its sibling `a stale marker beside a stale pin is dropped at the drain without a merge run` (line 273) already does — `awaitQuietHost()` + `t.skip` on a loaded host — so a starved host defers it instead of reddening a verdict the code never broke. The ci role files it; the bugfix role decides the fix.

### The backlog range reader (actionableEntryRanges) reads only `### ` headings, so `- `-bullet entries are invisible to the closed-entries index, the archive dedupe, and the bug wait-close

**Refused 2026-11-12 by bugfix: the entry's premise is false and its real symptom is a phantom-`##` archive split that no bugfix may repair — on the real archive `parseEntryDetails` and `actionableEntryRanges` both read `###`-only and return the identical 2 entries (verified offline, 2-vs-2, titles 8-133 and 134-145), so the range reader is *consistent* with the canonical reader, not blind to it, and the `-` one-line records are body content by the invariant-pinned INV-AX2 (src/verdict/fix-claim.ts `fixedSection`/`isOneLineRecord`); the ~2391 closed entries no reader walks all sit in a phantom-`##`-split section (BUGS-FIXED.md:146, a twin at PLANS-DONE.md:201) that an operator/director archive repair — not a bugfix, which may not edit archive files — must fix, and either of the entry's own "required behavior" branches rewrites that cross-cutting guarantee across twelve shared consumers in one tick, which grows complexity without justifying it.**

**Symptom.** `actionableEntryRanges` (src/backlog/backlog-index-data.ts, `line.startsWith("### ")` is the only entry-start test) is the shared entry reader for twelve modules, yet it recognizes only `### ` headings. The canonical reader `parseEntryDetails` (src/backlog/backlog-md.ts) and the date reader `eachEntryStart` (backlog-md.ts:359) both read `### ` headings AND `- ` bullets as entry-starts, and the team's roles compress most closed bugs into single-line `- ` bullets — BUGS-FIXED.md's `## Fixed` holds 1914 `-` bullets against 491 `###` headings. So the range reader is blind to the archive's majority shape.

**How to reproduce (offline, deterministic).** A scratch import over this tree: `actionableEntryRanges(BUGS-FIXED.md, "Fixed")` returns 1 range (a single `###` entry at line 43) out of 1914 bullets + 491 headings; the real newest closed entries (the `-` bullets at lines 8/20/30/…) are all skipped. Consequence 1 — the `<backlog-index>` block's `BUGS-FIXED.md ## Fixed (newest N)` (backlog-index.ts renderClosedSections, RECENT_CLOSED_MAX 5) lists stale `###` entries and never the actual newest closed bugs, in every role prompt. Consequence 2 — the archive dedupe (backlog-archive.ts entryFates, via entriesIn→actionableEntryRanges) matches selected entries against the archive's `###` entries only, so it cannot recognize a closed bug the archive already holds as a `-` bullet and will re-move it (duplicate). The same reader powers recordRecurrence (backlog-file-bugs.ts) and closeQuietWaitsText (backlog-bug-waits.ts).

**Suspected cause.** The `-` bullet is a valid one-line entry shape (parseEntryDetails and eachEntryStart read it; the team uses it for compressed closed entries), but the range walk was written for `###` headings only and never extended to the bullet shape, so every consumer of the range reader inherits the blind spot.

**Required behavior.** Decide the canonical entry shape for one-line entries and make the range reader match it. The fork: (a) make `actionableEntryRanges` read a top-level `- ` bullet as an entry-start (matching parseEntryDetails/eachEntryStart) so the closed index, archive dedupe, and bug wait-close all see the majority archive shape — the open `## Open` shape then needs a guard so a `- ` repro step inside an entry body is not misread as a sibling entry, or (b) canonicalize one-line entries to `### ` in the archive and close paths so the `###`-only reader is never blind. This is a plan-role design call (it touches twelve call sites and the entry-shape contract); the bugfix role records it, not force-picks a shape.

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
