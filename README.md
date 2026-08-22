# tumwater

An opinionated autonomous development harness built on [pi](https://github.com/badlogic/pi-mono).
You write the initial prompt; a fleet of role-driven loops builds the project with immense effort.

## Initial prompt

<!-- tumwater:prompt:start -->
Idea: agentic harness

Opinionated. Built on pi. Lots of autonomous loops. You only write the markdown/initial prompt.
It builds the project with immense effort. First puts the initial prompt and project status into
README.md. Background loops are observable by gui/tui/log. GUI/TUI also gives user a main prompt.
Loop sleeps a while when the prompt results in no further changes. Starts again after a while to
see if the answer has changed due to the new state of the world. Each run attempts to find
something to do, do one thing, commit, merge to main. The find-something-to-do part is role
specific. Each loop has a role:

- Make the code more organized
- Increase unit test code coverage
- Make the code cleaner
- Make the code less repetitive
- Implement a planned feature (tracked in PLANS.md)
- Fix a bug (tracked in BUGS.md in repo)
- Plan a feature (write markdown plan, add to PLANS.md)
- Keep the README up to date
- Make an improvement to the code

Assumptions: run within a git repo dir. Each loop uses a persistent git workspace and branch.
Each loop keeps itself synced up with git main. Don't involve git remotes at all; do everything
locally and keep all project state within the git repo.
<!-- tumwater:prompt:end -->

## Status

<!-- tumwater:status:start -->
v0.1: working harness, freshly renamed from "automaton" to "tumwater" (state and branches from
old checkouts migrate automatically; after pulling this change, rebuild and relink —
`npm run build && npm link` — for the `tumwater` command to appear on PATH). `init`, `run`,
`tui`, `gui`, `status`, `logs`, and `prompt` commands are implemented with all nine roles plus
the director loop (absolute scheduling priority; routes feature/bug requests into
PLANS.md/BUGS.md, decomposing independent subparts). Loops persist their pi sessions across
ticks and self-heal from context overflows; merge conflicts get one pi-driven resolution
attempt; roles can override provider/model/thinking; logs rotate and old pi sessions are
pruned; the TUI/status table is width-aware with a totals row. No open bugs; PLANS.md backlog
is empty.
<!-- tumwater:status:end -->

## How it works

`tumwater init "<prompt>"` seeds a git repo with README.md (your prompt + a status section),
PLANS.md, BUGS.md, and tumwater.json, and commits them. `tumwater run` then starts one loop
per enabled role. Every loop tick:

1. Resets its persistent worktree (`.tumwater/worktrees/<role>`, branch `tumwater/<role>`) to main.
2. Builds a role-specific "find something to do" prompt and runs `pi --print --mode json` in the
   worktree, resuming the loop's own pi session from earlier ticks (`--continue`) so context
   carries over; pi auto-compacts when it nears the model's window.
3. If pi changed files: commits, merges main into the branch, and fast-forwards main — all under a
   merge lock shared by every loop. If pi found nothing to do, the loop backs off (exponentially,
   capped) and sleeps.
4. Sleeping loops wake early when main moves — the world changed, so the answer may have changed.

The director loop is special: it executes prompts you type into the TUI (or `tumwater prompt`),
queued in a file-based inbox. It always has priority — a queued prompt starts immediately,
outside the `maxConcurrent` limit and ahead of every role loop, and queued prompts run back to
back with no cooldown between them. Everything is local git; no remotes are ever touched. Runtime state
lives in `.tumwater/` (gitignored); durable state (plans, bugs, status, config) lives in tracked
markdown and `tumwater.json`.

## Usage

```
npm install && npm run build

cd your-project        # any git repo
tumwater init "Build a tiny markdown-to-html converter CLI in Python."
tumwater run          # terminal 1: the loops (Ctrl+C to stop)
tumwater tui          # terminal 2: dashboard + main prompt
tumwater gui          # or the same dashboard at http://127.0.0.1:7180
tumwater status       # one-shot table
tumwater logs -f      # follow harness events
tumwater prompt "prefer no third-party deps"
```

Roles: `organize`, `coverage`, `clean`, `dry`, `feature`, `bugfix`, `plan`, `readme`, `improve`,
`director`. Enable/disable them, pick pi's provider/model/thinking level, and tune backoff in
`tumwater.json`.

## Notes on local model servers

- **LM Studio WARN flood** (`Reasoning setting 'high' is not supported by model '…'. Supported
  settings: 'on', 'off'. Falling back to reasoning setting 'on'.`): benign. pi requests its
  configured thinking level per turn; GGUF models that only expose an on/off reasoning toggle make
  LM Studio warn and fall back to `on`. Reasoning stays enabled; no tumwater or pi change needed.
  To silence it, set a thinking level the model supports (or none) in `tumwater.json` / pi settings.
- **Context accounting**: declare an honest `contextWindow` for the model in pi's `models.json` —
  it is what triggers pi's auto-compaction. With LM Studio's unified KV cache, concurrent requests
  share one context pool (declare pool ÷ slots); with unified KV off, each slot owns the full
  window. A session that overruns the server's real limit fails with "Context size has been
  exceeded"; the harness detects this and starts that loop a fresh session.

## Development

```
npm test               # build + unit tests (node:test)
```

Layout: `src/` harness code (`loop.ts` is the tick lifecycle, `orchestrator.ts` the scheduler,
`pi.ts` the pi subprocess integration, `git.ts` the worktree/merge machinery), `test/` unit tests.
Tests fake pi with a shell shim on PATH, so they run offline.
