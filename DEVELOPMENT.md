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
shim relative to `dist/` inside the checkout. Non-npm projects can replace the gate's check with
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

Cutting a release is one command; `scripts/release.mjs` does the bookkeeping and the
`Release` workflow (.github/workflows/release.yml) does the publish:

    node scripts/release.mjs patch   # or minor|major; omit to release the current version

It refuses to run on a dirty tree or a non-main branch, bumps package.json + lockfile
(when asked), commits as `tumwater(release): <version>`, pushes main, waits for CI to go
green, then tags `v<version>` and pushes the tag — the tag push triggers Release, which
re-runs the suite on the same Node the CI gate uses (lts/*), publishes to npm with
`--provenance` (OIDC trusted publishing; no token involved), and attaches the tarball to
a GitHub release. `node scripts/release.mjs --status` reports version/tag/CI state
without acting. Prerequisites (once): `gh` authenticated locally, and the trusted
publisher registered on npm (`npm trust github tumwater --file release.yml --repo
znation/tumwater --allow-publish`, package must already exist on the registry; first
`npm trust`/approve-style actions prompt for an interactive 2FA challenge).

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
- `src/pi.ts`: the pi subprocess integration.
- `src/git.ts`, `src/git-diff.ts`: git plumbing and git-output parsing.
- `src/worktree.ts`: the persistent worktree lifecycle.
- `src/landing-merge.ts`: the rebase, fast-forward, and conflict-resolution landing flow, on top of
  the git plumbing in `src/landing-git.ts` (rebase, conflict inspection, fast-forward).
- `src/pi-extension/`: the bundled bounded-output pi extension.
- `src/ui/`: TUI, GUI, status table, backlog report, transcript, and report rendering. Imported
  only by each other and `cli.ts`.
- `test/`: unit tests.
