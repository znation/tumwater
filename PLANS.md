# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

### Each run's completed compactions are counted and reported as `Compactions by role` (planned 2026-11-21 by the plan role)

**Goal.** The operator can see, in `tumwater report` and `tumwater report --since 24d --json`, how many
times a session was rewritten out from under each role's run. Today `src/pi/pi-stream.ts`'s
`PiStreamParser` recognises a completed compaction in two places (pi's `compaction_end` with a result and
not `aborted`, and the boundary-draft `entry_appended` whose `entry.type` is `compaction`, the arm that
plans/checkpoint-compaction-at-turn-boundary landed) but collapses both to one boolean, `compacted`, so a
run that compacted five times and one that compacted once look the same everywhere downstream. Nothing in
`src/`, `test/` or the archives counts compactions — `grep compactionsByRole` over `PLANS-DONE.md`,
`BUGS-FIXED.md`, `docs/cli.md`, `src/` and `test/` returns 0 hits.

**Approach.** One integer, carried end to end on the same path the prompt-token telemetry already takes.

- `src/pi/pi-stream.ts`: add a `compactions = 0` counter beside `compacted`; the two arms that set
  `compacted = true` each increment it, and no other event does. `compacted` keeps its exact meaning
  (INV-DD1) — the counter is a third decision, next to the flag and the progress count that
  `countProgress` already keeps separate.
- `src/agent/agent-settle.ts`: `PiRunResult` gains `compactions: parser.compactions` where it already
  sets `compacted: parser.compacted`, and the false/zero default in the same file's empty-result shape.
  `test/fakes/fake-pi.ts` gains the matching zero default so every fake-backed run stays at zero.
- `src/run/run-usage.ts`: the fold gains a `compactions` window folded for every run (like
  `promptTokens`, not authoring-only — merge and review sessions re-compact too) and cleared by `reset`.
- `src/run/run-finalize.ts` `logRunEnd`: writes `compactions: n` on `run_end`, omitted when zero, exactly
  as the `promptTokens`/`peakContextTokens` fields beside it are omitted, so an older event and a
  compaction-free run render byte-identically.
- Report fold and render, mirroring `imageReroutesByRole` cell for cell: `UsageFold.compactionsByRole`
  plus a `foldRunEnd` contribution that adds the healed `ev.compactions` (non-negative finite, else 0) to
  `eventRole(ev)` in `src/report/report-usage-fold.ts`; `setMapIfNonempty` and `narrowToRole` in
  `src/report/report-data.ts`; the `--since` key union member and its `scopedByRole` entry in
  `src/report/report-since-data.ts`; `compactionsByRole?: Record<string, number>` on the day shape and the
  required field on the since shape in `src/report/report-types.ts`; and one `pushRankedRoleLine` in
  `src/report/report-render.ts` and in `src/report/report-since-render.ts`, placed immediately after the
  `Refusals by role` line.
- `docs/cli.md`: extend the `tumwater report` sentence in the Audit row (the one that enumerates
  `Refusals by role`, `Image reroutes by role`, …) with the new ranked line, team-and-role-scoped wording
  like the refusals clause.
- `docs/invariants.md` INV-DD1: add the new parser test names to its `Pinned by.` list, since the section
  now pins counting as well as the boolean.

**Files touched.** `src/pi/pi-stream.ts`, `src/agent/agent-settle.ts`, `src/run/run-usage.ts`,
`src/run/run-finalize.ts`, `src/report/report-usage-fold.ts`, `src/report/report-data.ts`,
`src/report/report-since-data.ts`, `src/report/report-types.ts`, `src/report/report-render.ts`,
`src/report/report-since-render.ts`, `docs/cli.md`, `docs/invariants.md`,
`test/pi-parser.test.ts`, `test/run-usage.test.ts`, `test/run-finalize.test.ts`, `test/report.test.ts`,
`test/fakes/fake-pi.ts`.

**Acceptance criteria.**

- Given a stream with one completed `compaction_end` and one boundary-draft `entry_appended` of
  `type: "compaction"`, the parser reports `compactions === 2` and `compacted === true`; given a
  `compaction_start` whose end never arrives, or a `compaction_end` with `aborted: true`, it reports
  `compactions === 0` and `compacted === false`; an `entry_appended` of any other entry type leaves both
  untouched (extend the four existing compaction cases in `test/pi-parser.test.ts`, which today assert
  only the boolean).
- Given two folded runs of 1 and 3 compactions, the accumulator's window reads 4, and after `reset` it
  reads 0 (`test/run-usage.test.ts`, beside the prompt-token window cases).
- Given a run whose fold counted compactions, its `run_end` event carries `compactions: 2`; given none,
  the event has no `compactions` key at all (`test/run-finalize.test.ts`).
- Given a day whose events hold a refused feature run and two compactions on a `feature` run and one on a
  `clean` run, `tumwater report` prints `**Compactions by role:** feature — 2 · clean — 1` on the line
  directly after `**Refusals by role:** …` (the same desc-by-count, name-ascending tie-break as the
  refusals line), and `--json` carries `compactionsByRole: { feature: 2, clean: 1 }` on that day; a day
  with no compaction carries no key and prints no line. A `--since` window sums both days, and
  `tumwater report --role feature` narrows the line to `feature — 2` (`test/report.test.ts`, mirroring the
  existing `Refusals by role` test's team-plus-scoped assertions). The day/since shape fixtures in
  `test/report.test.ts` that spell every cell out gain the key.
- No run_end or report output changes for any event written before this change: a run_end without a
  `compactions` field folds as 0 and prints no line.

**Out of scope.** Telling a checkpoint-driven compaction from pi's automatic one — the harness writes
`details: { kind: "checkpoint", accepted, declined }` on the entries it drafts, so that split is a
deliberate follow-up plan, not part of this counter.

## Done
