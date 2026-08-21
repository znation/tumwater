# automaton

An opinionated autonomous development harness built on [pi](https://github.com/badlogic/pi-mono).
You write the initial prompt; a fleet of role-driven loops builds the project with immense effort.

## Initial prompt

<!-- automaton:prompt:start -->
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
<!-- automaton:prompt:end -->

## Status

<!-- automaton:status:start -->
v0.1: working harness. `init`, `run`, `tui`, `gui`, `status`, `logs`, and `prompt` commands are
implemented with all nine roles plus the director loop (which has absolute scheduling priority
and routes feature/bug requests into PLANS.md/BUGS.md). Merge conflicts get one pi-driven
resolution attempt; roles can override provider/model/thinking; logs rotate and old pi sessions
are pruned. 72 unit tests pass. Known issues (BUGS.md): the TUI status table scrolls off-screen
as recent activity grows, and LM Studio's log fills with WARN lines while loops run (cause under
investigation). No plans pending in PLANS.md.
<!-- automaton:status:end -->

## How it works

`automaton init "<prompt>"` seeds a git repo with README.md (your prompt + a status section),
PLANS.md, BUGS.md, and automaton.json, and commits them. `automaton run` then starts one loop
per enabled role. Every loop tick:

1. Resets its persistent worktree (`.automaton/worktrees/<role>`, branch `automaton/<role>`) to main.
2. Builds a role-specific "find something to do" prompt and runs `pi --print --mode json` in the worktree.
3. If pi changed files: commits, merges main into the branch, and fast-forwards main — all under a
   merge lock shared by every loop. If pi found nothing to do, the loop backs off (exponentially,
   capped) and sleeps.
4. Sleeping loops wake early when main moves — the world changed, so the answer may have changed.

The director loop is special: it executes prompts you type into the TUI (or `automaton prompt`),
queued in a file-based inbox. It always has priority — a queued prompt starts immediately,
outside the `maxConcurrent` limit and ahead of every role loop, and queued prompts run back to
back with no cooldown between them. Everything is local git; no remotes are ever touched. Runtime state
lives in `.automaton/` (gitignored); durable state (plans, bugs, status, config) lives in tracked
markdown and `automaton.json`.

## Usage

```
npm install && npm run build

cd your-project        # any git repo
automaton init "Build a tiny markdown-to-html converter CLI in Python."
automaton run          # terminal 1: the loops (Ctrl+C to stop)
automaton tui          # terminal 2: dashboard + main prompt
automaton gui          # or the same dashboard at http://127.0.0.1:7180
automaton status       # one-shot table
automaton logs -f      # follow harness events
automaton prompt "prefer no third-party deps"
```

Roles: `organize`, `coverage`, `clean`, `dry`, `feature`, `bugfix`, `plan`, `readme`, `improve`,
`director`. Enable/disable them, pick pi's provider/model/thinking level, and tune backoff in
`automaton.json`.

## Development

```
npm test               # build + unit tests (node:test)
```

Layout: `src/` harness code (`loop.ts` is the tick lifecycle, `orchestrator.ts` the scheduler,
`pi.ts` the pi subprocess integration, `git.ts` the worktree/merge machinery), `test/` unit tests.
Tests fake pi with a shell shim on PATH, so they run offline.
