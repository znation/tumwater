# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

_None yet._

### The compaction count says how many of them the operator's own checkpoints drove: `Checkpoint compactions by role` beside the total (planned 2026-11-21 by the plan role)
When a session is rewritten, tumwater counts it but not who asked: `Compactions by role` holds pi's
automatic threshold/overflow compactions and the checkpoint-driven ones from
`plans/agent-backends.md` checkpoint-driven compactions in one number, so an operator watching that
line cannot tell whether the keep-alive compactions are landing or whether pi is still force-
compacting on its own. The landed `Compactions by role` plan named this split as its own deliberate
follow-up — its **Out of scope** line records that the harness writes
`details: { kind: "checkpoint", accepted, declined }` on the entries it drafts, so the split is a
follow-up plan, not part of that counter.

**How it works.** A completed compaction carries its origin in the payload tumwater already parses.
`src/pi/pi-stream.ts` `applyCompaction` counts a completed compaction on two arms: a
`compaction_end` that did not abort and carries an object `result`, and an `entry_appended` whose
`entry` is a `compaction` entry. Each arm's payload has a `details` field, and pi 1.5.2 fills it on
both: `compact()` returns
`details: { readFiles, modifiedFiles }`, which the automatic threshold/overflow path
(`_runAutoCompaction` → `compact()`) carries into the `compaction_end` result it emits, while a
`turn_end` boundary draft's details are carried into the stored entry unchanged.
Only an entry written by tumwater's checkpoint extension has `details.kind === "checkpoint"`
(`src/pi-extension/checkpoint.ts` writes that shape on the compaction entry it drafts at `turn_end`,
and `test/checkpoint.test.ts` asserts `details.kind === "checkpoint"` on both the draft and the
resolved entry) while pi's own details carry no `kind`. So the parser classifies each completed
compaction it already counts: a checkpoint-driven one when a `details.kind === "checkpoint"` sits on
the payload in front of it (the `entry_appended` entry's `entry.details`, or the `compaction_end`
event's `result.details`), and an automatic one otherwise. `applyCompaction` gains a per-kind counter next
to `compactions`; the `compacted` flag and the total keep their current meaning, and no new event
function or session read is needed. `PiRunResult` gains `checkpointCompactions` beside `compactions`
(`src/pi/pi-run-result.ts`, filled in `resultFromParser` in `src/agent/agent-settle.ts`, whose zero
shape gets the field too), `RunUsage.fold` sums it the way it sums `compactions` in
`src/run/run-usage.ts`, and `src/run/run-finalize.ts` writes `checkpointCompactions` on `run_end`
only when it is above zero, exactly as `compactions` is written, so every older event still folds and
renders identically. The claude translator is unchanged: its `compact_boundary` marker becomes
`compaction_end` with an empty `result` (no `details` in `src/agent/claude/claude-stream.ts`), so a
claude compaction stays in the total and out of the checkpoint split — stated, not guessed at.

**Report and CLI.** `UsageFold` gains `checkpointCompactionsByRole` (`src/report/report-usage-fold.ts`),
the `DayFold` shared shape and `ReportDay.checkpointCompactionsByRole` gain it as an optional field
while `ReportSinceWindow` gains it as a required one (`src/report/report-fold.ts`,
`src/report/report-data.ts` — `setMapIfNonempty`/`narrowToRole` — `src/report/report-since-data.ts`
— the union keys and `scopedByRole` — `src/report/report-types.ts`), and the renders add one line
through the same `pushPresentRankedLine` helper, printed directly after the existing
`**Compactions by role:**` line in both `src/report/report-render.ts` and
`src/report/report-since-render.ts`. No new flag, subcommand, or format: the line is the contract.
`docs/cli.md`'s `report` row adds the new line to its list of what the `report` section prints, next
to `Compactions by role`, and says the split is pi-backend-only.
`docs/invariants.md`'s compaction-coverage guarantee (INV-DD1) gains one sentence: a completed
compaction is classified by its payload's `details.kind`, a payload that carries none counts toward
the total only, and `tumwater report` never shows more checkpoint compactions than compactions.

**Files touched:** `src/pi/pi-stream.ts`, `src/pi/pi-run-result.ts`, `src/agent/agent-settle.ts`,
`src/run/run-usage.ts`, `src/run/run-finalize.ts`, `src/report/report-usage-fold.ts`,
`src/report/report-fold.ts`, `src/report/report-data.ts`, `src/report/report-since-data.ts`,
`src/report/report-types.ts`, `src/report/report-render.ts`, `src/report/report-since-render.ts`,
`test/fakes/fake-pi.ts` (its run-result shape gains the field beside `compactions: 0`),
`test/pi-parser.test.ts`, `test/claude-stream.test.ts`, `test/report.test.ts`,
`docs/cli.md`, `docs/invariants.md`.

**Acceptance:**
- A canonical stream with one `entry_appended` whose `entry.details.kind` is `"checkpoint"` and one
  `compaction_end` whose `result.details` is `{ readFiles: [], modifiedFiles: [] }` parses to
  `compactions: 2` and `checkpointCompactions: 1` in `test/pi-parser.test.ts` — and a stream with a
  bare `compaction_end` (`result: {}`, an older pi build) still parses to `compactions: 1` and
  `checkpointCompactions: 0`.
- The `run_end` the runner writes for a run with one checkpoint-driven and one automatic compaction
  carries both `"compactions": 2` and `"checkpointCompactions": 1`; for a run with two automatic
  compactions it carries `"compactions": 2` and no `checkpointCompactions` key at all.
- `tumwater report --days 2` over events with `compactions: 2, checkpointCompactions: 1` on a
  `feature` run_end prints `**Compactions by role:** feature — 2` then, on the next line,
  `**Checkpoint compactions by role:** feature — 1`; `--json` carries
  `checkpointCompactionsByRole: { feature: 1 }` on that day, and a compaction-free day carries no
  key and prints no line. `tumwater report --since 6h` prints the same two lines summed over the
  window, and `--role feature --since 6h` narrows both maps to the base role.
- claude's `compact_boundary` line still yields the `compaction_start`/`compaction_end` pair
  (`test/claude-stream.test.ts` unchanged on that point) and its run reports the compaction in the
  total with `checkpointCompactions` absent from the event.

## Done
