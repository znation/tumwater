# Developing tumwater

```bash
npm install && npm run build && npm link   # build from source and put `tumwater` on PATH
npm test                                   # lint + build + the unit suite (what the landing gate runs)
npm run lint                               # just the lint: no-floating-promises (see eslint.config.js)
npm test merge                             # only test files whose name contains "merge"
npm test 'loop#resume'                     # …and inside them, only tests whose name contains "resume"
npm run test:e2e                           # live-orchestrator e2e tier, kept out of the gate
npm run test:coverage [filter]             # the unit suite with node's coverage table
```

Tests fake pi with a shell shim on PATH, so they run offline. `test/test-runner.ts` keeps the
harness's own variables out of the suite (`TUMWATER_PI_BIN`, which outranks PATH, and the
supervisor's marker), so a suite a fleet starts sees the same fakes as one run by hand. Drop any
new variable the harness honors there too. The e2e tier stays out of the gating suite because its
wall-clock waits are not load-proof. Coverage runs go through the runner too (`npm run
test:coverage`), never raw `node --test` or a tree compiled elsewhere — the fakes resolve their
shim relative to `dist/` inside the checkout. The root `vitest.config.mjs` is a tripwire, not a config: it makes `npx vitest`
refuse to start here (BUGS.md 2026-10-05). Non-npm projects can replace the gate's check with
`check.command` in tumwater.json (`command`, optional `cwd` and `timeoutSeconds`).

Both suite scripts start with `scripts/live-checkout-guard.mjs`, which refuses to run in a
checkout a live fleet runs from (its `.tumwater/state/orchestrator.json` names a live pid): the
suite's first steps recompile and restamp the `dist/` that fleet executes and its dashboards
watch. Run suites in a worktree. For the same reason a test never writes the running checkout's
own `dist/` or `tumwater.json`. The gui reload test in `test/cli-gui.test.ts` serves a copy of
`dist/src` from a fixture repo instead.

## CI

GitHub Actions runs the lint+build+unit gate on every push and pull request, a `package`
job packs the npm tarball on main pushes and uploads it as a workflow artifact, and a tag
push (`v*`) runs the release workflow, which attaches the packed tarball to a GitHub release.

## Releases

Main always carries the **next** version; a release tags the version main already has:

    node scripts/release.mjs                  # release: push main, wait for CI, tag v<version>
    node scripts/release.mjs bump [patch|minor|major]   # right after a release: bump, commit, push
    node scripts/release.mjs --status         # report version/tag/CI state without acting

The release flow refuses a dirty tree or a non-main branch, pushes main, waits for CI to
go green, then tags `v<version>` — the tag push triggers Release, which re-runs the suite
on the same Node the CI gate uses (lts/*), publishes to npm with `--provenance` (OIDC
trusted publishing; no token involved), and attaches the tarball to a GitHub release.
The tag always names the exact commit CI green-lit while package.json still said the
released version, so the workflow's tag-vs-version check passes trivially. The bump is a
separate `tumwater(release): <version>` commit made AFTER a release (it replays on a
rejected push, since the fleet lands commits continuously), keeping main's version
meaning what's next while npm's `latest` means what shipped.
Prerequisites (once): `gh` authenticated locally, and the trusted publisher registered
on npm (`npm trust github tumwater --file release.yml --repo znation/tumwater
--allow-publish`, package must already exist on the registry; first `npm trust`
commands prompt for an interactive 2FA challenge).

## Keeping the suite fast

The suite is bound by process creation, not by its own code: a run starts ~12,000 git processes
plus hundreds of npm, CLI and fake-pi children, and macOS tops out at a few thousand spawns a
second. `test/test-runner.ts` sets the environment up for that: it puts the real git binary
ahead of the xcode-select shim on macOS, turns off git's auto-maintenance and init templates,
and starts files longest-first by the durations it records in `dist/test/.durations.json`.

- Install a fake command with `writeScript` (test/fake-commands.ts), never by writing and `chmod`ing a new
  executable. macOS scans every newly created executable on its first exec (~150 ms, much more
  under load). `writeScript` symlinks the one committed `test/fixtures/script-shim` instead.
- Put timing on logical time rather than real sleeps. `watchdogClock` drives runPi's quiet
  watchdog, stall warning and (with `timeouts`) tick timeout; `waitForLogLines` waits until the
  run's raw log shows the output the test is about to act on.
- Synchronize on events or files, never on a sleep. Don't assume that two concurrent runs overlap:
  make one wait for the other (bounded), because a fast fake can finish before its sibling starts.
- Split a test file that grows past ~10 s run alone (`npm test <name>`); files run in parallel,
  tests inside a file do not.

## Keeping Node children out of LaunchServices (macOS)

On macOS, a Node process that sets `process.title` registers with LaunchServices, and
launchservicesd keeps a Mach port for it after it exits. npm sets a title on every run and pi at
startup. The kernel kills launchservicesd near 268K ports, and the GUI session wedges until a
forced power-off (BUGS.md 2026-09-28). The harness starts pi and every build check with
`withoutLaunchServicesCheckIn` (src/process.ts), which covers every process below them. Give any
new spawn site that starts npm, pi or other title-setting Node programs in bulk the same
`env: withoutLaunchServicesCheckIn(process.env)`. `tumwater doctor` reports the count on its
`mach ports` line, and a running fleet warns from 100K.

## Layout

- `src/loop.ts`: the tick lifecycle. `src/loop-pi.ts` holds its pi-run plumbing.
- `src/orchestrator.ts`: the scheduler; `src/orchestrator-launch.ts` holds its launch pass
  (admitting due runners to their ticks).
- `src/pi/pi.ts`: the pi subprocess integration, beside its plumbing (`pi-args.ts`,
  `pi-stream.ts`, `pi-event-line.ts`, `pi-run-result.ts`, `pi-models.ts`, `pi-watchdogs.ts`).
- `src/git-run.ts`: the git execution layer (spawn, GitError, commit identity).
- `src/git.ts`, `src/git-diff.ts`: git queries over that layer and git-output parsing.
- `src/worktree.ts`: the persistent worktree lifecycle.
- `src/landing/landing-merge.ts`: the rebase, fast-forward, and conflict-resolution landing flow, on top of
  the git plumbing in `src/landing/landing-git.ts` (rebase, conflict inspection, fast-forward).
- `src/pi-extension/`: the bundled bounded-output pi extension.
- `src/ui/`: TUI, GUI, status table, backlog report, and transcript rendering. Imported only by
  each other and the CLI command layer that drives it (`cli.ts` and the `src/` command bodies).
- `src/history.ts`, `src/tick-detail.ts`, `src/report.ts`: the `history`, `tick`, and `report`
  CLI command bodies, beside the collector modules (`history-data.ts`, `tick-detail-data.ts`,
  `report-data.ts`) whose payloads they print, `src/log-commands.ts` (the `logs` command body),
  and `src/cli-query-commands.ts` (the other
  read-only command bodies).
- `test/`: unit tests.
