# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

_None yet._


### The model check's verdicts survive an orchestrator restart (planned 2026-11-21 by the plan role)

**Why.** `ModelCheckGate` keeps every pair's verdict in memory only, so when a deploy or a crash
restarts the orchestrator the map is empty and a pair that had failed is `checking` again: every
role on it is held while a fresh probe runs, and the doubling back-off (`retryMs`, capped at
`maxRetryMs`) is thrown away and restarts at one interval — a host that has been down for an hour
gets re-probed every `retryMs` instead of waiting out the back-off it already earned.
`plans/model-check.md`'s `## Not covered (follow-ups)` records exactly this: "Verdicts are in memory
only, so every restart (including self-redeploys) re-checks every pair and holds the roles for the
probe's few seconds." Do that follow-up.

**Approach.**

1. `src/paths.ts`: add `modelChecksPath(root)` returning `.tumwater/state/model-checks.json`,
   beside `githubIssuesPath`/`piListedModelsPath`/`qaCoveragePath`. The file holds
   `{ pairs: Record<string, ModelCheckEntry>, savedAt: number }` — one entry per pair in the same
   shape `recordModelCheck`/`recheckModelChecks` already produce (`pair`, `status`, `failures`,
   `probeAt`, `retryMs`, `probing`, `checkedAt`, and the optional `reason`/`reply`/`detail`), so no
   new verdict model is introduced.
2. `src/model-check/model-check.ts`: add `readModelCheckPairs(root): ModelCheckMap` and
   `writeModelCheckPairs(root, map): void` beside the other state helpers, reading through
   `readJsonFile` and writing through `writeJsonAtomic` (both `src/files/json-files.ts`) inside a
   best-effort wrapper that swallows a write error the way `stampHeartbeat`
   (`src/orchestrator/orchestrator-poll.ts`) does — a read-only working tree never breaks the
   check. Both normalize what they touch: the reader drops an entry that is not an object, drops
   any entry with `probing` true, and forces `probeAt`/`retryMs`/`failures` to finite numbers
   (`retryMs` floored at the policy's `retryMs`, so a corrupt file cannot make the check spam a
   provider); the writer also drops `probing` entries, because an in-flight probe dies with the
   process and a restart must not leave a pair looking mid-probe forever. The writer stamps
   `savedAt` (epoch ms) itself.
3. `src/model-check/model-check-gate.ts`: the constructor, which already takes `root`, seeds
   `this.checks` by passing the persisted map to `rekeyModelChecks` as the map to update — that
   function already keeps an existing entry for a pair in use (`map[pair] ?? {status: "checking",
   probeAt: now}`), so a persisted `failed` pair keeps its `probeAt`/`retryMs`/`failures` and stays
   held until its back-off comes due, while a pair the config added since is still `checking` with
   `probeAt: now`. A persisted `verified` pair starts `probing: false`, so the first poll does not
   re-probe it. Then persist the map from `poll()`, after `this.publish(input.info)` — not from
   `settle` alone, because the busy-deferral branch of `settle` and the `recheckNow()`/`suspect()`
   back-off changes land in the same map and are worth keeping. Write only when what would be
   written differs from the JSON this gate last wrote (hold that string in a private field), the
   same only-when-changed rule `publishInfoFields` uses for the info block, so a steady poll leaves
   the file untouched.
4. Same constructor, immediately after the seed: a sweep for a stale store. When the file's
   `savedAt` is absent or older than `this.policy.suspectMinMs` (10 minutes in
   `MODEL_CHECK_POLICY`), every seeded entry is re-opened for probing — `{ ...e, probing: false,
   probeAt: now }` — so the first poll probes every pair. Do not reuse `recheckModelChecks` for
   this: it moves only `failed` entries and leaves a `verified` one with `probeAt: null`, so a
   verdict days old would be trusted and that pair never probed again (a fault on it would surface
   only through `suspectModelCheck`). Stamping `probeAt: now` on every entry keeps today's restart
   behaviour for stale data — "every restart re-checks every pair" — while a store written within
   the suspicion interval keeps its verdicts and its earned back-off. No change to
   `src/orchestrator/orchestrator.ts` or `src/orchestrator/orchestrator-poll.ts` is needed: the
   gate is already built there with `root` and the policy, and its `poll` publishes and persists.
5. `src/team/team-orchestrator-info.ts`: `ModelCheckInfo` gains `savedAt?: number` — the store's
   stamp, copied onto every row the gate's `publish` builds — so the dashboard and the doctor can
   tell a verdict read from disk at restart from one probed in this process. `parseModelCheck` must
   keep the field the way it keeps `probeAt`/`checkedAt` (`isFiniteNumber` guard), or a round-trip
   through `readOrchestratorInfo` silently drops it. The doctor (`checkModelChecks` in
   `src/doctor/doctor-fallback-checks.ts`, which takes the info block's `ModelCheckInfo[]`) needs no
   change: the info block stays the single live source.
6. Docs: rewrite that `plans/model-check.md` follow-up bullet to say the verdicts are persisted
   (naming `modelChecksPath` and the restart path); extend the model-check paragraph in
   `docs/how-it-works.md` (the one that starts "The model check proves every model pair the team can
   run on can answer" and ends "The check runs for `tumwater start`, not for a `--once` round") with
   one sentence naming `.tumwater/state/model-checks.json` and saying the verdicts and their
   back-off survive a restart, and that a verdict older than the suspicion interval is re-probed
   rather than trusted. `docs/invariants.md` binds no model-check symbol today (grep it for
   `ModelCheckGate`: no match), so add nothing there.

**Files touched:** `src/paths.ts`, `src/model-check/model-check.ts`,
`src/model-check/model-check-gate.ts`, `src/team/team-orchestrator-info.ts`, `plans/model-check.md`,
`docs/how-it-works.md`; tests in `test/paths.test.ts`, `test/model-check.test.ts`,
`test/orchestrator-model-check.test.ts`.

**Acceptance criteria.**

- `test/paths.test.ts`: `modelChecksPath(root)` is `.tumwater/state/model-checks.json`, and both
  "config lives at the repo root; every other runtime state lives under .tumwater" and "pins the
  full runtime layout" name the new path (the same two entries every new state file has to name).
- Gate unit test in `test/model-check.test.ts` (the `manualProber`/`makeRepo`/`POLICY` style): a
  gate constructed over a `.tumwater/state/model-checks.json` recording `local/flint` as `failed`
  with `failures: 3` and a future `probeAt` holds that pair's roles and starts no probe at all on
  its first poll; the same pair with a past `probeAt` is probed once. After the first gate's probe
  fails, a second gate over the same file sees `failures: 4`; after one answers, `readModelCheckPairs`
  reports that pair as `verified`.
- A corrupt store is survived: with `{"pairs":{"local/flint":{"status":"nope","retryMs":"x",
  "probeAt":null}}}` on disk, the gate does not hold the pair forever — it probes it on its first
  poll — and the next write leaves the file valid JSON whose `retryMs` is a finite number at least
  `POLICY.retryMs`.
- Restart end to end, in `test/orchestrator-model-check.test.ts` (the `makeFastRepo` + `fakePiNoCheck`
  pair `local/flint`): the first orchestrator round leaves the pair failed and
  `.tumwater/state/model-checks.json` on disk; a second `runRepoOrchestrator` over the same repo,
  whose fake pi answers probes with word salad, starts no probe while the recorded back-off still
  runs — its fake's probe-log count stays where the first round left it — and its
  `orchestrator.json` still carries the `failed` row for that pair, with its `failures` count and a
  `savedAt` number.
- A stale verdict is re-tested, not trusted: with a store whose `savedAt` is older than
  `POLICY.suspectMinMs` and whose `local/flint` entry is `verified`, a gate over that file probes
  that pair on its first poll instead of letting its roles run on a verdict days old; with the same
  file one minute old, the gate starts no probe. A `failed` entry with a `probeAt` a day ahead is
  held past that `probeAt` when the store is fresh, and probed on the first poll when it is stale.
- No other reader appears: the doctor's model-check row and the dashboard still get their verdicts
  from `orchestrator.json` alone, so `checkModelChecks(false, null)` over a host that has a
  `.tumwater/state/model-checks.json` but no running orchestrator still returns the green row
  "not checked — a running team checks each model pair before running on it".

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
