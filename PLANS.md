# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned
_None yet._

### The `salvage patches` doctor row and its standing alert say how long a kept patch has before session retention prunes it, so an operator never learns about the deadline from a gone file (planned 2026-11-22 by the plan role; the landed dashboard salvage-View plan recorded this gap verbatim as a follow-up (PLANS-DONE.md "**Not covered (follow-ups).** ... the `salvage-patches` alert counts them but never says one is going stale, and session retention can still prune a kept patch an operator never opened") and `grep -c "session retention prunes them" src` prints exactly one hit, the row's remedy clause, which states the threat without a date; `grep -rn "prunes in\|session retention is off\|at the next prune pass" src docs test` printed 0 before this entry; independent in files of both `## Planned` entries — the report-tally entry takes `src/report/` and docs/cli.md's `tumwater report` row, the issues-View entry takes `src/github/github-issues-render.ts`, `src/cli/cli-query-commands.ts`, `src/gui/gui-*issues*`, `src/ui/gui/gui-client-settings.ts` and docs/cli.md's `tumwater issues` row, and neither names `src/doctor/`, `src/ui/team-alert-standings.ts` or the `tumwater status` row; this one edits no `docs/invariants.md` line at all (INV-T6 already pins that the amber detail is `checkSalvagePatches`'s warn sentence whole, and INV-BQ5 already pins the prune window, so both guarantees are unchanged and need no edit); touches src/doctor/doctor-salvage.ts src/doctor/doctor.ts src/ui/team-alert-standings.ts docs/cli.md docs/how-it-works.md docs/config.md test/doctor-checks.test.ts test/team-alerts.test.ts)

**Problem.** A kept workspace patch under `.tumwater/salvage/` is deleted by the session-retention pass
(`pruneFileHalves`, src/orchestrator/retention.ts — `pruneOldFiles(salvageDir(root), days)`), and the only
warning an operator gets is the doctor `salvage patches` row and the standing amber `salvage-patches`
alert, whose warn sentence ends "... before session retention prunes them". That says a deadline exists
and never says when: the row already prints the oldest patch's age (`oldest 1h`) but not the window it is
measured against (`sessionRetentionDays`, default 7, `0` disables pruning — `RetentionPruner`'s
constructor), so an operator looking at a 6-day-old patch cannot tell it is hours out, and one looking at
a team with `sessionRetentionDays: 0` cannot tell it will never be pruned at all. `checkSalvagePatches`
(src/doctor/doctor-salvage.ts) reads no config today; both of its call sites have one at hand —
`doctorSteps` already receives `config` (from `loadConfigSafe`) and `buildStandingAlerts` already
destructures `config` from its `StandingAlertsInput` — so the number can be passed rather than guessed.
`collectSalvagePatches` (src/status/status-salvage.ts) already carries each patch's `savedAt` (the file's
mtime, the very field `pruneOldFiles` compares), so no new read is needed.

**Approach.** One sentence, phrased once, in the row that the alert already copies verbatim.

- `src/doctor/doctor-salvage.ts`: `checkSalvagePatches(root, retentionDays: number, now: number = Date.now())`
  — a required window parameter, so no surface can silently claim a window the team does not run. Add a
  module-private `retentionClause(oldestSavedAt: number, retentionDays: number, now: number): string` that
  returns the clause inserted between the named-patch list and the remedy:
  - `retentionDays > 0`, deadline ahead (`deadline = oldestSavedAt + retentionDays * DAY_MS`, `DAY_MS` from
    src/text/datetime.ts): `; session retention prunes a patch older than ${retentionDays}d, so the oldest
    goes in ${humanUntil(deadline, now)}` (`humanUntil` is src/text/datetime.ts's future-direction
    countdown — s/m/h/d buckets).
  - `retentionDays > 0`, deadline already passed (a stopped team, a failed pass): `; session retention prunes
    a patch older than ${retentionDays}d, so the oldest goes at the next prune pass` — never a `0s` countdown.
  - `retentionDays === 0`: `; session retention is off, so these patches are never pruned`.
  The warn sentence becomes `${count} kept for you (oldest ${age}, ${file}): ${named}${more}` + the clause +
  ` — apply one with \`tumwater salvage --apply <n>\`, or read one with \`tumwater salvage --show <n>\` or
  delete one with \`tumwater salvage --drop <n>\`` — the stale "before session retention prunes them" tail
  moves into the clause. The ok sentence stays byte-identical, the level stays warn in all three window
  shapes (a disabled window is information, not a new warning), and the row still writes nothing.
- `src/doctor/doctor.ts`: the `salvage patches` step passes the window the team runs,
  `config?.sessionRetentionDays ?? defaultConfig().sessionRetentionDays`, the same last-good/default
  fallback shape `doctor-contention-checks.ts` uses for `maxConcurrentChecks`; a config that will not load is
  the `init` row's and the standing `config-problem` alert's to name, and this row's doc comment says so.
- `src/ui/team-alert-standings.ts`: `pushSalvagePatchesAlert(out, root, config.sessionRetentionDays)` —
  `buildStandingAlerts` already has `config` in hand (`configForStatus`'s last-known-good read), so the alert
  arm passes it to `checkSalvagePatches` and keeps copying the row's warn sentence whole through
  `pushDoctorTwinAlert`. No new alert, key, tone or action; no change to any other arm.
- Docs, one sentence each: docs/cli.md's `tumwater status` row, the `salvage-patches` clause (the alert now
  names the retention window and says outright when it is off); docs/how-it-works.md's kept-patches sentence
  (the row and alert name how long the oldest has left); docs/config.md's `sessionRetentionDays` row (kept
  salvage patches report their deadline on `tumwater doctor` and `tumwater status`).

**Acceptance criteria.**

- Given one patch saved 1 h ago and `sessionRetentionDays: 1`, `checkSalvagePatches(root, 1, now)` returns
  `warn` and a detail containing, in this order: `1 salvaged workspace patch kept for you`, `oldest 1h`,
  `1. a.patch`, `; session retention prunes a patch older than 1d, so the oldest goes in 23h`,
  `` tumwater salvage --apply <n> ``.
- Given the same 1 h-old patch and `retentionDays: 0`, the detail contains
  `; session retention is off, so these patches are never pruned`, still reads `warn`, and names no countdown.
- Given a patch 2 h old and `retentionDays: 1`, the detail contains
  `so the oldest goes at the next prune pass` and matches neither `/goes in 0s/` nor `/goes in -/`.
- With no patch and with a `pending/<role>/`-only tree, the ok details are byte-identical to today's.
- `tumwater status`'s amber `salvage-patches` alert detail equals the row's warn sentence for the same
  tree and the same configured window — including the `sessionRetentionDays: 0` form — and an absent
  `salvagePatches` snapshot still raises nothing.
- Every existing `checkSalvagePatches` call in test/doctor-checks.test.ts gains the window argument; no
  other row name, `--json` key (`salvagePatches`' `{ position, file, savedAt, bytes }` shape) or dashboard
  card output changes (test/doctor.test.ts's row-name list and test/status-payload.test.ts's salvage suite
  pass untouched).

**Not covered (follow-ups).** `tumwater salvage`'s own list still prints each patch's age but not its
deadline; the dashboard's salvage card rows do the same; a kept patch that will outlive a never-restarted
team is not separately named.

**One plausible bug this pins.** Swapping the deadline test (reading `deadline < now` as the countdown arm)
would print `goes in 0s` for a patch the pass has not reached yet and `at the next prune pass` for one with
23 h left — the 1 h/1 d case pins the 23 h figure and the 2 h/1 d case pins the passed-deadline wording, so
either swap fails one of them. A row that passed `defaultConfig().sessionRetentionDays` instead of the
loaded config would answer the 0-window criterion with a 7 d countdown.

## Done
