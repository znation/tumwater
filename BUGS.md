# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### Five root-walk tests fail on a shared host once a stale `.tumwater` dir sits at the system temp root (found by the bugfix role 2026-11-16)

Found while verifying a fix: a full `npm test` reded on exactly five tests, all in the `.tumwater`-root-walk family — `findTeamRoot` / `nearestTumwaterRoot` / `writeFullOutput` (test/check-slots.test.ts, test/paths.test.ts, test/full-output.test.ts) — and they pass in isolation on a clean host. The five are `findTeamRoot finds the ancestor holding .tumwater/state`, `writeFullOutput returns null when no ancestor has .tumwater/`, `findTumwaterRoot walks up to the harness root`, and the two `nearestTumwaterRoot` cases.

**Reproduce.** `npm test` on a host whose `os.tmpdir()` is a directory that already holds a `.tumwater` dir with a `state` subdirectory. On this shared host the system temp root is `/tmp` and a leaked `/tmp/.tumwater/state` (from an earlier run) sat there, so the tests walked up from their per-test temp dir into `/tmp/.tumwater/state` and returned `/tmp` (or the wrong root) instead of `null`, failing the assertion "a dir with no `.tumwater`/`state` ancestor has no team root." The same tests pass in isolation on a host whose `os.tmpdir()` is a clean per-user dir, and the suite's `--affected` gate is green.

**Suspected cause.** The root-walk tests create per-test dirs under `os.tmpdir()` (the `tmpdir()` fixture, test/fixtures/repo-fixtures.ts) and assert "no ancestor has `.tumwater`/`state`", but they have no quiet-host skip and no guard against a `.tumwater` dir at the temp root. On a shared host that already holds a stale `.tumwater` (leaked by an earlier run — the same `$TMPDIR/.tumwater` poisoning recorded in BUGS-FIXED, the `runAgent` notes-shim fallback), those assertions fail. A full suite that runs with the system temp root as `os.tmpdir()` can also write its own `.tumwater` there (it creates `<tmp>/.tumwater/{bin,log}`), so the poison is self-perpetuating run-to-run on such a host.

### `tumwater plan --file` silently drops a series part's `requires … landed` clause, so the part is handed out before its prerequisite lands (reported by the user 2026-11-16)

A series part filed through `tumwater plan --file` (or `tumwater plan "<title>"`, or the dashboard's file endpoint) loses its dependency. `appendOperatorEntry` (src/backlog/backlog-write.ts) writes the heading as `### <title> (<stamp>)`, so the operator stamp `(reported by the user <date>)` becomes the heading's last parenthetical. `requiresClause` (src/backlog/backlog-parts.ts) reads the `requires … landed` clause only from the trailing parenthetical (or an open one), so a title like `S, part 2/2: B (requires S part 1/2 landed)` parses to no prerequisites once stamped. The claim allocator then treats part 2/2 as ready and a feature run can claim it while part 1/2 is still planned or in flight. Nothing warns: `planDependencyProblems`'s `unparsed` list only catches a clause that is found but parses to nothing, and its `misworded` scan looks for other dependency verbs, not a `requires` clause in an earlier parenthetical.

This matters more now that the intended use is an operator's own agent filing plans (PLANS.md "Operator steering" series): an agent filing a series the documented way gets it silently unordered. The 2026-11-16 Operator steering series had to be written into PLANS.md by hand and landed under the merge lock for this reason.

**Reproduce.** On the built tree: `requiredParts("S, part 2/2: B (requires S part 1/2 landed)")` returns `[{series: "S", part: "1", of: 2}]`, and `requiredParts("S, part 2/2: B (requires S part 1/2 landed) (reported by the user 2026-11-16)")` returns `[]`. End to end: in a fixture repo, `tumwater plan --file` a part 1/2 and then a part 2/2 whose title ends in `(requires S part 1/2 landed)`; `tumwater plan --list` shows part 2/2 as ready instead of `[blocked: …]`.

**Suspected cause.** The filing path and the dependency parser disagree on where heading metadata lives. Either fix is plausible; pick the one that keeps every other heading reader (`stripEntryStamp`, `entryDates`, `entryKey`, the retired-stamp readers) consistent: (a) when the filed title already ends in a parenthetical, fold the operator stamp into it as `(…; reported by the user <date>)` instead of appending a second group; or (b) have `requiresClause` look at every top-level parenthetical in the heading, not only the last. Also consider having `planDependencyProblems` report a `requires … landed` clause that sits outside the parenthetical it reads, so a hand-written heading with the same shape is caught.

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
