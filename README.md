# tumwater

tumwater is an opinionated autonomous development harness built on
[pi](https://github.com/badlogic/pi-mono). You write a short project brief, and a fleet of
role-driven loops (feature, bugfix, planning, tests, cleanup, docs, and more) builds the project
one small, reviewed commit at a time. It came from wanting to write only the brief and let a team
of always-on specialists do the rest: each loop owns one concern, lands one change per tick,
sleeps when it has nothing to do, and wakes when main moves. All project state lives in the
local git repo, and no remote is ever touched.

![The tumwater web dashboard: the loop fleet mid-run, with live per-loop state, tick/commit/token counts, last results, the shared backlog of planned features and open bugs, the event feed, and the director prompt box](docs/gui.png)

## Status

<!-- tumwater:status:start -->
**v0.1**: working harness. All 13 roles and the director are enabled by default.

Open work: [PLANS.md](PLANS.md) (planned), [BUGS.md](BUGS.md) (open bugs),
[QUESTIONS.md](QUESTIONS.md) (open questions).

Current main (`d448481`): build clean, suite 1607/1607.
<!-- tumwater:status:end -->

## Usage

```bash
npm install -g tumwater     # or run any command with npx tumwater
                            # from a checkout: npm install && npm run build && npm link
cd your-project             # a new or existing directory
tumwater init "Build a tiny markdown-to-html converter CLI in Python."
tumwater run                # start the loops (Ctrl+C to stop)
```

Then, from another terminal:

| To | Run |
| --- | --- |
| Watch the fleet | `tumwater tui`, or `tumwater gui` for the browser dashboard at http://127.0.0.1:7180 |
| Check state | `tumwater status`, `tumwater logs -f`, `tumwater logs --role <id>` |
| Steer the project | `tumwater prompt "prefer no third-party deps"` queues a request for the director |
| Control the loops | `tumwater pause` / `resume`, `tumwater wake` (skip backoff), `tumwater abort --role <id>` |
| Audit | `tumwater doctor` (pre-flight), `tumwater report` (usage and cost), `tumwater report --failures` |

`tumwater help` lists every command and flag. `gui --all-interfaces` exposes the dashboard, and
with it the director prompt, to your whole network, so pair it with `--token <secret>`.

Settings live in `tumwater.json`: enabled roles, model, intervals, the daily spend cap
(`maxDailyCostUsd`), and user-defined `customLoops`. Edits apply live while the fleet runs.

**Backends:** any OpenAI-compatible model pi can reach works; set `provider` and `model` in
`tumwater.json`. See [docs/backends.md](docs/backends.md) for requirements and a worked setup.

For how the loops, review gate, scheduling, and self-redeploy work, see
[docs/how-it-works.md](docs/how-it-works.md).

## Appendix: initial prompt

The brief this repository was started from, kept for history. The harness still reads it from
between the markers below on every tick.

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
