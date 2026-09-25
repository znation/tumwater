# Developing tumwater

```bash
npm install && npm run build && npm link   # build from source and put `tumwater` on PATH
npm test                                   # build + the unit suite (what the landing gate runs)
npm test merge                             # only test files whose name contains "merge"
npm run test:e2e                           # live-orchestrator e2e tier, kept out of the gate
```

Tests fake pi with a shell shim on PATH, so they run offline. The e2e tier stays out of the gating
suite because its wall-clock waits are not load-proof. Non-npm projects can replace the gate's
check with `check.command` in tumwater.json (`command`, optional `cwd` and `timeoutSeconds`).

## Keeping the suite fast

The suite is bound by process creation, not by its own code: a run starts ~12,000 git processes
plus hundreds of npm, CLI and fake-pi children, and macOS tops out at a few thousand spawns a
second. `src/test-runner.ts` sets the environment up for that: it puts the real git binary
ahead of the xcode-select shim on macOS, turns off git's auto-maintenance and init templates,
and starts files longest-first by the durations it records in `dist/test/.durations.json`.

- Install a fake command with `writeScript` (test/util.ts), never by writing and `chmod`ing a new
  executable. macOS scans every newly created executable on its first exec (~150 ms, much more
  under load). `writeScript` symlinks the one committed `test/fixtures/script-shim` instead.
- Put timing on logical time rather than real sleeps. `watchdogClock` drives runPi's quiet
  watchdog, stall warning and (with `timeouts`) tick timeout; `waitForLogLines` waits until the
  run's raw log shows the output the test is about to act on.
- Synchronize on events or files, never on a sleep. Don't assume that two concurrent runs overlap:
  make one wait for the other (bounded), because a fast fake can finish before its sibling starts.
- Split a test file that grows past ~10 s run alone (`npm test <name>`); files run in parallel,
  tests inside a file do not.

## Layout

- `src/loop.ts`: the tick lifecycle. `src/loop-pi.ts` holds its pi-run plumbing.
- `src/orchestrator.ts`: the scheduler.
- `src/pi.ts`: the pi subprocess integration.
- `src/git.ts`, `src/git-diff.ts`: git plumbing and git-output parsing.
- `src/worktree.ts`: the persistent worktree lifecycle.
- `src/merge.ts`: the rebase, fast-forward, and conflict-resolution landing flow.
- `src/pi-extension/`: the bundled bounded-output pi extension.
- `src/ui/`: TUI, GUI, status table, transcript, and report rendering. Imported only by each other
  and `cli.ts`.
- `test/`: unit tests.
