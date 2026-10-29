# Developing tumwater

```bash
npm install && npm run build && npm link   # build from source and put `tumwater` on PATH
npm test                                   # lint + build + the unit suite (what the merge runs)
npm run test:gate                          # build + lint + the nearest tests that fit 30 s
npm run lint                               # just the lint: no-floating-promises (see eslint.config.js)
npm test merge                             # only test files whose name contains "merge"
npm test 'runner#resume'                   # …and inside them, only tests whose name contains "resume"
npm run test:e2e                           # live-orchestrator e2e tier, kept out of the gate
npm run test:coverage [filter]             # the unit suite with node's coverage table
```

Tests fake pi with a shell shim on PATH, so they run offline. `test/test-runner.ts` keeps
tumwater's own variables out of the suite (`TUMWATER_PI_BIN`, which outranks PATH, and the
supervisor's marker), so a suite a team starts sees the same fakes as one run by hand. Drop any
new variable tumwater honors there too. It keeps a run's `TUMWATER_RUN` mark, so the run's exit
sweep reaps a suite the run started, and it makes itself the owner of every node process in the
suite, so killing the runner (`kill $PID`) stops node --test and its workers too. The e2e tier stays out of the gating suite because its
wall-clock waits are not load-proof, and it runs its files one at a time (`--test-concurrency=1` on
node 20.10+), so each waits against a quiet host rather than competing with its siblings. Coverage runs go through the runner too (`npm run
test:coverage`), never raw `node --test` or a tree compiled elsewhere — the fakes resolve their
shim relative to `dist/` inside the checkout. The root `vitest.config.mjs` is a tripwire, not a
config: it makes `npx vitest` refuse to start here (BUGS.md 2026-10-05). Non-npm projects can
replace the merge's check with `check.command` in tumwater.json (`command`, optional `cwd` and
`timeoutSeconds`).

Comments wrap at 100 columns; code lines have no limit. `test/comment-width.test.ts` enforces it.

Every suite script starts with `scripts/live-checkout-guard.mjs`, which refuses to run in a
checkout a live team runs from (its `.tumwater/state/orchestrator.json` names a live pid): the
suite's first steps recompile and restamp the `dist/` that team executes and its dashboards
watch. Run suites in a worktree. For the same reason a test never writes the running checkout's
own `dist/` or `tumwater.json`. The gui reload test in `test/cli-gui.test.ts` serves a copy of
`dist/src` from a fixture repo instead.

## The gate runs the nearest tests

The team's review gate runs `npm run test:gate` before each model review
(`check.gateCommand` in tumwater.json), and the merge lock runs it again on the rebased tree
(`check.mergeCommand` falls back to it). It is meant to finish in about a minute on a loaded
host, so it checks only what is nearest the change:

- the same compile as `npm test`;
- the lint, over only the files the change touches (`scripts/lint-changed.mjs`). A change to the
  lint config, the dependencies or `tsconfig.json` lints the whole tree;
- the test files nearest the change that fit a 30 s budget (`test-runner.js --affected
  --budget=30`, selection in `test/affected-tests.ts`). It ranks the files the change can reach
  by import distance (a changed test file first, then files that import a changed module, and
  so on), cheapest first at each distance. It prices each file by the durations this build last
  recorded (`dist/test/.durations.json`, 5 s for a file never timed) and passes over a file that
  does not fit. Its first line of output says how many fit and names the left-out files nearest
  the change: run those by hand (`npm test <name>`) when your change is about them.

Everything else runs in the main watch's full check (`npm test`) on main's tip after the merge,
which the team keeps running on every new head. A break that only the full suite catches lands
on main, and the watch hands it to ci's red-main heal, which fixes it forward. Reachability alone
was not enough to bound the gate: the orchestrator, merge and CLI modules import most of the
tree, so a typical change reached a quarter of the suite and one in ten nearly all of it. Gates
then ran 4–10 minutes under load and timed out. Some single test files take minutes on their
own and never fit the budget; splitting them is how they get back into the gate.

The selection follows the compiled tree. It reads imports, `new URL("…", import.meta.url)` file
references, and, for the CLI, the command each call to the test harness names. So keep these
visible to it:

- Reach another file by import or by `new URL("…", import.meta.url)`, not by assembling a path
  from strings. A test that reads directories or derives paths from `import.meta` itself runs on
  every code change.
- Call the CLI through `test/helpers/cli-harness.ts` with the command as a string literal
  (`cli(repo, "logs", …)`, `spawnCli(repo, ["run", …])`, `[CLI, "status"]`). A computed command
  makes the file depend on every command.
- Changes to `package.json`, the lockfile, `tsconfig.json` or the runner itself make every test
  file a candidate, as does any file the selector cannot map, and the budget then takes the
  cheapest. It says so in its first line of output.

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
rejected push, since the team merges commits continuously), keeping main's version
meaning what's next while npm's `latest` means what shipped.
Prerequisites (once): `gh` authenticated locally, and the trusted publisher registered
on npm (`npm trust github tumwater --file release.yml --repo znation/tumwater
--allow-publish`, package must already exist on the registry; first `npm trust`
commands prompt for an interactive 2FA challenge).

## Checking rendered output by hand

Two scripts run the compiled build against a seeded fake team rather than through the
suite, for a change whose point is that the dashboards should look identical:

- `scripts/diff-check.mjs` renders one fixture through the baseline build and the working
  build at three widths (default, 120, 60) and compares the TUI status-table strings and the
  GUI `/api/status` payloads exactly — the safety net for a refactor of
  `src/status/status-data.ts`, `src/ui/status-render.ts`, or the status payload. Stage the
  baseline once from a clean main checkout, then rebuild the worktree after your change:

      npm run build && rm -rf /tmp/tw-baseline && mkdir /tmp/tw-baseline && cp -R dist /tmp/tw-baseline/   # from a clean main checkout
      npm run build && node scripts/diff-check.mjs                                                         # from the worktree

  It prints `DIFF-CHECK PASS`, or the mismatching TUI lines and GUI fields, and exits
  nonzero on any difference.
- `scripts/bench-live.mjs` times one dashboard frame (`snapshot` + `renderStatus`) over the
  same fixture, best of three runs; run it before and after a change to the status read or
  render path and compare the `us/frame` number.

Neither is part of `npm test`; both name the `npm run build` fix when `dist/` is missing.
`npm run tumwater <args>` runs the compiled CLI from a checkout (the same `dist/src/cli.js`
build) with its exit code, for trying a change before `npm link`.

## Keeping the suite fast

The suite is bound by process creation, not by its own code: a run starts ~16,000 git processes
plus ~700 CLI children and hundreds of npm, `ps` and fake-pi children, and macOS tops out at a
few thousand spawns a second. Roughly, a git spawn costs 8 ms of CPU, a CLI child 90 ms, and an
`npm run` 150 ms. `test/test-runner.ts` sets the environment up for that: it puts the real git binary
ahead of the xcode-select shim on macOS, turns off git's auto-maintenance and init templates,
and starts files longest-first by the durations it records in `dist/test/.durations.json`.

- Prefer `makeRepo()` to building a repo with git commands: it copies a per-process template
  instead of spawning init, add and commit. Every repo it makes in one process shares a seed
  SHA, so a test must not rely on two fresh repos having different commits.
- Read refs through `src/git/git.ts` (`headOf`, `refSha`, `hasCommits`, `branchExists`,
  `isGitRepo`, `repoToplevel`). They answer from the repository's files when the files settle
  it and only spawn git otherwise. A new read-only probe should do the same.
- Keep `src/cli.ts`'s command modules behind `await import()` inside their case. Every CLI child
  a test starts loads only the dispatcher's shared core plus its own command.
- Install a fake command with `writeScript` (test/fakes/fake-commands.ts), never by writing and
  `chmod`ing a new executable. macOS scans every newly created executable on its first exec
  (~150 ms, much more under load). `writeScript` symlinks the one committed
  `test/fixtures/script-shim` instead.
- Put timing on logical time rather than real sleeps. `watchdogClock` drives runPi's stall
  watchdog, stall warning and (with `timeouts`) run timeout; `waitForLogLines` waits until the
  run's raw log shows the output the test is about to act on.
- Synchronize on events or files, never on a sleep. Don't assume that two concurrent runs overlap:
  make one wait for the other (bounded), because a fast fake can finish before its sibling starts.
- Split a test file that grows past ~10 s run alone (`npm test <name>`); files run in parallel,
  tests inside a file do not.

## Keeping Node children out of LaunchServices (macOS)

On macOS, a Node process that sets `process.title` registers with LaunchServices, and
launchservicesd keeps a Mach port for it after it exits. npm sets a title on every run and pi at
startup. The kernel kills launchservicesd near 268K ports, and the GUI session wedges until a
forced power-off (BUGS.md 2026-09-28). tumwater starts pi and every build check with
`withoutLaunchServicesCheckIn` (src/process/process.ts), which covers every process below them.
Give any new spawn site that starts npm, pi or other title-setting Node programs in bulk the same
`env: withoutLaunchServicesCheckIn(process.env)`. `tumwater doctor` reports the count on its
`macOS port leak` line, and a running team warns from 100K.

## Layout

- `src/runner/runner.ts`: the runner class and its lifecycle/public surface. `src/runner/runner-pi.ts`
  holds its pi-run plumbing, `runner-run.ts` the run pipeline phases, `runner-recovery.ts` the
  abort/pin/recovery phases, and `runner-fallback.ts` the model-fallback fold.
- `src/orchestrator/orchestrator.ts`: the scheduler; `src/orchestrator/orchestrator-launch.ts`
  holds its launch pass (admitting due roles to their runs).
- `src/agent/`: the backend-neutral agent runner (`agent-run.ts` — the spawn, the
  `tumwater_run` marker, watchdogs, abort, stderr capture, and the live feed), its post-run
  settlement (`agent-settle.ts` — spawn-error result, exit orphan sweep, and close-time
  reconcile/classify that assembles the `PiRunResult`), the `AgentBackend` interface with its
  id-keyed registry (`agent-backend.ts`),
  and the per-run session ledger the resume paths query (`session-ledger.ts`).
- `src/pi/pi.ts`: the pi facade (`runPi` alias, `hasResumableSession`, the stderr-match
  constants) over the backend-neutral runner, beside its adapter (`pi-backend.ts`) and plumbing
  (`pi-args.ts`, `pi-stream.ts`, `pi-event-line.ts`, `pi-run-result.ts`, `pi-models.ts`,
  `pi-watchdogs.ts`).
- `src/config/config.ts`: the config core (load, defaults, per-role views) beside its
  plumbing (`config-schema.ts`, `config-validation.ts`, `config-write.ts`, `config-live.ts`,
  `config-views.ts`, `config-example.ts`, `config-editable-keys.ts`, `config-field-checks.ts`),
  with the `config` CLI command body beside it in `src/cli/cli-config-commands.ts`.
- `src/git/git-run.ts`: the git execution layer (spawn, GitError, commit identity).
- `src/git/git.ts`, `src/git/git-diff.ts`: git queries over that layer and git-output parsing.
- `src/build/build-info.ts`: the build stamp (dist/build-info.json), beside the staged compile
  (`build-stage.ts`) and the deterministic pre-check (`build-check.ts` and its plumbing,
  `build-check-*.ts`).
- `src/git/worktree.ts`: the persistent worktree lifecycle.
- `src/text/`: the shared human-facing text-shaping family — `text.ts` (whitespace,
  truncation, integer parsing) beside the single-format homes split from it: `format.ts`
  (number, money, and hash formats), `datetime.ts` (local date/time and day math), and
  `text-width.ts` (terminal-column geometry). Presentation only; imported by every layer.
- `src/merge/merge-to-main.ts`: the rebase, fast-forward, and conflict-resolution merge flow,
  on top of the git plumbing in `src/merge/merge-git.ts` (rebase, conflict inspection,
  fast-forward).
- `src/run/`: the per-run pipeline (`run-stage.ts`, `run-prompt.ts`, `run-timing.ts`,
  `run-usage.ts`, `run-verdict.ts`, `run-finalize.ts`, `run-apply.ts`, `run-resume.ts`,
  `run-detail.ts`, `run-detail-data.ts`, `run-outcome.ts`).
- `src/pi-extension/`: the bundled pi extensions, loaded on every pi run in this order:
  bounded-output (head+tail cap on oversized tool results), context-shake (reclaims old bulky
  results at 70% of the window), context-budget (context-usage notes at 50/70/85%),
  strip-thinking (drops replayed thinking on a chat-completions model with a window of at most
  256k), trim-system-prompt (drops pi's docs section from the system prompt at a window of at
  most 128k), write-guard (refuses an edit or write outside the run's worktree; the rule is
  `src/agent/write-guard.ts`, which claude's PreToolUse hook and OpenCode's plugin share). bounded-output's caps and
  context-shake's thresholds were tuned on a 128k window and scale down on a smaller declared
  window, through the shared arithmetic in `context-window.ts`.
- `src/gui/`: the `tumwater gui` command and the dashboard's HTTP transport — the CLI entry
  (`gui-command.ts`), the server (`gui-server.ts`), its /api GET and POST handlers
  (`gui-endpoints.ts`, `gui-endpoint-commands.ts`), the shared request/response plumbing
  (`gui-http-body.ts`), and the endpoint argument checks (`gui-args.ts`). The browser view it
  serves lives in `src/ui/gui/`; this directory owns the socket and the control endpoints,
  not the page.
- `src/ui/`: the shared status table, backlog report, and transcript rendering; `src/ui/gui/`
  holds the browser dashboard's page and client assets and `src/ui/tui/` the ink terminal
  renderer. Imported only by each other and the command layer that drives it — the `cli.ts`
  dispatcher, the read-only command bodies in `src/cli/`, `src/run/run-detail.ts` (the `tick`/`history`
  command body, whose transcript it renders via `src/run/run-detail-render.ts`), and the dashboard transport in `src/gui/`; `test/layering.test.ts` pins that importer set.
- `src/history/history.ts`, `src/run/run-detail.ts`, `src/report/report.ts`: the `history`,
  `tick`, and `report` CLI command bodies, beside the collector modules (`history-data.ts`,
  `src/run/run-detail-data.ts`, `src/report/report-data.ts`, `src/report/report-since-data.ts`)
  whose payloads they print,
  `src/cli/cli-log-commands.ts` (the `logs` command body), and `src/cli/cli-query-commands.ts` (the
  other read-only command bodies; `src/cli/follow-view.ts` holds the repaint loop those
  `-f/--follow` views share).
- `src/status/`: the `status` collector behind the status table, TUI, and dashboard
  (`status-data.ts` — a thin composer over the per-domain collectors `status-roles.ts`,
  `status-inbox.ts` and `status-budget.ts`) and its per-poll cached readers; rendering lives
  in `src/ui/status-render.ts`.
- `src/gates/`: the scheduler's admission gates — daily budget, disk floor, quiet hours,
  pause, startup/readiness, per-role caps, the maintenance quota, error streaks, and the team
  failure hold (`gate-polls.ts` polls them).
- `src/team/`: team-wide state (`team-state.ts` — the pause markers and their writers), the
  provider/kind hold, the team polls, the failure spread and error-storm alarms, and the
  worktree reclaim pass (`reclaim.ts`).
- `src/scheduling/`: scheduling primitives — per-role waits between runs, the quiet-hours parser,
  multi-instance claims, and the `--once` round.
- `src/verdict/`: the agent reply contract — the NOTHING_TO_DO and REFUSED sentinels, the
  SUMMARY/WHY/RISK/VERIFIED block, the review VERDICT line, and the refusal and fix-claim
  readers.
- `src/review/`: the adversarial review gate (`review.ts`) and its helpers — pre-review
  verification, verdict parsing, the missing-verdict follow-up, suite reruns, doc-only
  exemptions, and known flakes.
- `src/baseline/`: the pristine-main baseline check and the red-main detection that verifies
  main itself and feeds the merge-side `main_red` pin and the `ci` healer hand-off, with no
  authoring block.
- `src/redeploy/`: the update path — the staleness policy, the probes that decide a
  safe restart, and the production redeployer.
- `src/doctor/`: the `tumwater doctor` pre-flight checks and their shared report contract.
- `src/inbox/`: the inbox — the director's and per-role inboxes, image attachments,
  submit/edit/cancel, and the inbox-backed `prompt` command body.
- `src/operator/`: the layer for your commands, shared by the
  `pause`/`resume`/`wake`/`abort`/`stop`/`retire` CLI commands, the dashboard's POST routes,
  and the TUI's controls.
- `src/backlog/`: the BUGS/PLANS/QUESTIONS markdown — the stat-cached readers, the text
  reader/writer, its structure, its renderer, and its eligibility marks; the QUESTIONS.md
  reader/writer core (`question-answer.ts`) sits here, shared by the CLI's `questions` command
  body, the TUI's answer box, and the dashboard's POST route.
- `src/brief/`: the project brief — the managed prompt/status sections, reading the
  brief back out (`brief.ts`), and the shared writer that replaces it under the primary lock
  (`brief-edit.ts`).
- `src/budget/`: the daily cost budget's accounting and the fallback circuit breaker.
- `src/change/`: the `tumwater diff` collector and renderer.
- `src/concurrency/`: the merge lock, the semaphores, and the check-permit gate.
- `src/events/`: the append-only event log — its writers, the tail and windowed readers,
  event formatting, and the day-window derivation.
- `src/failure/`: the failure digest — collection, clustering, time-and-spend, and rendering.
- `src/files/`: filesystem helpers — tolerant JSON reads, stat caching, size-based tailing,
  and the serialized file queue.
- `src/init/`: `tumwater init` and its bundled template catalog.
- `src/process/`: process spawning and supervision — the supervisor, process groups, the
  process table, and the macOS LaunchServices guard.
- `src/prompt/`: the prompt dialect, principles, and the merge's pi-run prompt text
  (`prompt.ts`, `prompt-followup.ts`, `gate-prompts.ts`, `gate-notes.ts`) a run's prefill is assembled from.
- `src/roles/`: the role catalog, its role ids, per-role guidance, and the per-role views the
  CLI and dashboards read.
- Top-level modules: `src/cli.ts` (the dispatcher), `src/paths.ts` (repo layout constants),
  `src/version.ts`, `src/project-name.ts`, `src/collections.ts`, `src/errno.ts`, and
  `src/request-timeouts.ts`.
- `test/`: unit tests.
