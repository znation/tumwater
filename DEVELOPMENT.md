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
