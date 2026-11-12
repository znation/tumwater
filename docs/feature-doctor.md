# Feature: Doctor

`tumwater doctor` is the operator's audit of the whole team: a read-only pre-flight that
runs ~80 named checks against `.tumwater/` and the git repo, prints a report the operator can
read in the terminal, the TUI Health pane or the dashboard, and offers five repair flags for
the findings it can fix. It is the command an operator reaches for to find out what is wrong
with a team that will not start or will not land. (Terms here follow the
[glossary](glossary.md).)

## Summary

- **What it is.** `runDoctor` (src/doctor/doctor.ts) composes a `DoctorReport`
  (src/doctor/doctor-checks.ts: `{ header, checks, routing, verdict }`): a header naming the
  running orchestrator's pid/version (or "not running"), the ordered check table, the
  backend-routing table (every seam the config can spawn, with its model selector and
  backend), and a one-line verdict ("ready to run", or the failing count).
- **What it does not do.** Every check is read-only against `.tumwater/` and none runs the
  project's build or test suite (that is the declared check's job, not a pre-flight's). A
  check that throws becomes its own fail row via `runDoctorCheck` and the rest still run
  (the INV-CE1 invariant) — so doctor reports without repairing or aborting, and works
  identically with or without a running harness.
- **The repair side.** Five flags mutate before the report and are refused by `--json` and the
  follow form; the report itself is always read-only.

## User experience

From the `tumwater doctor` command (src/cli/cli-doctor-command.ts, `cmdDoctor`), the operator
has three one-shot forms plus a live one:

- **Default.** Runs every check and prints the report (`renderDoctor`,
  src/doctor/doctor-render.ts); the exit code is 1 when any check fails, 0 otherwise —
  warnings never fail the exit.
- **`--problems`.** Prints only the warn and fail rows (`problemsOnly` /
  `renderDoctorProblems`), hiding the ok rows while still counting them for the verdict and
  exit code.
- **`--list-checks`.** Prints every check name in report order without running any check or
  touching the repo, so the operator picks a name for `tumwater doctor <check>…` (the `--only`
  filter). The names live in `DOCTOR_CHECK_NAMES` (src/doctor/doctor-check-names.ts).
- **`-f`/`--follow`.** Repaints the report every couple of seconds until Ctrl+C or the parent
  process exits. The live form is read-only, so `--json` and every repair flag are refused
  with it.

**Repair flags.** Five mutate before the report and are refused by `--json` and the follow
form; the spec is in src/cli/cli-flag-specs.ts. Each prints its result before the report in
text form, and `--json` carries each result on the payload:

- `--kill-orphans` — kill orphaned agent processes.
- `--commit-backlog` — commit each dirty tracked backlog file.
- `--resync-install` — re-sync the root checkout's install.
- `--drop-broken-pins` — drop broken `refs/tumwater/` pins.
- `--retire-leftovers` — retire disabled roles' leftover branches.

**Surfaces besides the CLI.** The TUI Health pane (src/ui/tui/tui-pane-health.ts) and the
dashboard (src/gui/gui-admin-endpoints.ts, `handleDoctor`) run the same doctor read-only.

## Check families

The ordered `doctorSteps` table (src/doctor/doctor.ts) groups into families, named here by
example rather than enumerated — the full list is `tumwater doctor --list-checks`:

- **Environment and repo setup** — `node`, `node binary`, `git binary`, `repo`, `init`,
  `config key names`, `brief`, `principles`, `bootstrap`, `state dir`.
- **The agent backends** — `claude auth`/`version`/`api key`, `opencode`, the `codex …` rows,
  `backend binary`.
- **Budget and contention** — `budget`, `provider waits`, `provider contention`,
  `check contention` (src/doctor/doctor-contention-checks.ts).
- **Main and the build** — `main's check`, `check` (`checkBuildCheck`,
  src/doctor/doctor-project-checks.ts), `ci parity`, `remote CI`, `qa coverage`, `update`.
- **Backlog health** — `plans stuck in Planned`, `backlog headings`, `refusals`,
  `stalled entries`, `plan dependencies`, `stale questions`, `stale bugs`, `held bugs`,
  `regressed fixes`, `flaky checks`, `uncommitted backlog` (the backlog rows live in
  src/doctor/doctor-backlog-plans.ts and doctor-backlog-bugs.ts).
- **On-disk team state** — `merge lock`, `workspaces`, `parallel instances`,
  `salvage patches`, `leftover role branches`, the tumwater-pins row, `disk space`, `orphans`.

Each row carries a `name` and a `CheckOutcome` (ok/warn/fail + detail), built with the
`okOutcome`/`warnOutcome`/`failOutcome`/`noConfigOutcome` constructors in
src/doctor/doctor-outcome.ts.

## Rationale

- The doctor is the one command an operator reaches for to find what is wrong with a team, so
  it belongs as a documented feature with its own doc, like the other built features.
- It is a *reporter*, not a *pre-flight gate* — read-only and side-effect-free by default —
  so it is safe to run against a broken or half-started team, and the repair flags stay
  explicit opt-ins rather than auto-fixes.

## Constraints and notes

- Every check is read-only against `.tumwater/`; none runs the project's build/test. The five
  repair flags are the only mutators, and the report it renders is always the pre-mutation
  state.
- A check that throws becomes its own fail row and the rest still run; doctor never aborts a
  run partway.
- **Config keys it reads**, so an operator knows what to tune when a row warns (all in
  [config](config.md) / src/config/config-schema.ts): `maxDailyCostUsd` (the `budget` row),
  `diskHoldGB`/`diskReclaimGB` (the `disk space` row), `maxConcurrent`/`maxConcurrentChecks`
  (the contention rows).
