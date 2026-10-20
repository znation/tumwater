# tumwater

tumwater is an opinionated autonomous development team, built on
[pi](https://github.com/badlogic/pi-mono). You write a short project brief, and a team of
roles (feature, bugfix, planning, tests, cleanup, docs, and more) builds the project
one small, reviewed commit at a time. It came from wanting to write only the brief and let a team
of always-on specialists do the rest: each role owns one concern, merges one change per run,
sleeps when it has nothing to do, and wakes when main moves. All project state lives in the
local git repo, and no remote is ever touched. The words used here (team, role, run, merge) are
defined in [docs/glossary.md](docs/glossary.md).

![The tumwater web dashboard running tumwater's own team: a sidebar with the project, its team status, and the Team, History, Usage, Failures, and Settings views, with today's spend against the cap and the pause control; the director prompt box; and today's progress (roles running, commits merged, runs, open backlog) above the roles grouped by what they are doing, each with its status, current work or last result, spend, and controls](docs/gui.png)

## Install

Requires Node 20.3 or later on macOS or Linux.

```bash
npm install -g tumwater
```

Or run any command without installing: `npx tumwater`. To run from a checkout of this repo
instead: `npm install && npm run build && npm link`.

With `claude` installed and logged in, `npm run smoke:claude` is an opt-in live check of the
claude backend: it drives the real CLI through a throwaway repo (a few cents of API-equivalent
spend on a subscription) and is not part of `npm test`, which stays green without claude. `npm run
smoke:opencode` is the same live check for the opencode backend, driving the real `opencode` CLI
against its free DeepSeek tier; it needs an OpenCode V2 install (`brew install opencode`) and is
also outside `npm test`.

## Status

<!-- tumwater:status:start -->
**v0.2.1**: working tumwater. The director and 14 of the 15 roles are enabled by default; `selfcheck`,
which files tumwater bugs from tumwater's own event log, is opt-in (`roles.selfcheck.enabled`).

Open work: [PLANS.md](PLANS.md) (planned), [BUGS.md](BUGS.md) (open bugs),
[QUESTIONS.md](QUESTIONS.md) (open questions).
<!-- tumwater:status:end -->

## Usage

```bash
cd your-project                 # a new or existing directory
tumwater init "Build a tiny markdown-to-html converter CLI in Python."
                                # --template, --file, and --adopt pick a starting point (see docs/cli.md)
tumwater start                  # start the team (Ctrl+C to stop)
tumwater start --gui            # ... and serve the browser dashboard at http://127.0.0.1:7180
tumwater start --tui            # ... and attach the terminal TUI in the same window
tumwater start --for 2h         # run for a bounded window, then finish current work, summarize, and exit
tumwater start --once           # one round of runs for cron/CI; exits 3 if a run failed
```

A fresh or empty project is seeded with `"bootstrap": {"untilPlansDone": 5}`, which holds the
maintenance roles until 5 plans are done; remove it from `tumwater.json` to end that early.

From another terminal, `tumwater tui` or the browser dashboard watches the team, `tumwater status`
and `tumwater logs -f` check it, `tumwater brief --file <path>` replaces the brief,
`tumwater prompt "<text>"` sends a message to the director's inbox, `tumwater plan` and
`tumwater bug` file backlog entries, `tumwater revert <sha>` undoes one merged change on main,
and `tumwater pause`, `resume`, `wake`, and `stop` control the roles. `tumwater doctor` audits the team and `tumwater report` shows usage and cost. `gui
--all-interfaces` exposes the dashboard, and with it the director prompt, to your whole network,
so pair it with `--token <secret>`.

`tumwater prompt --attach <image>` gives a role an image to read at its next run. When a role's
model cannot read images, the command refuses the attachment up front (naming the fix) unless
the role reroutes a blind read to a vision model, in which case it says where the message will
run; `tumwater doctor` probes each claimed image-input model once (cached 7 days, `--reprobe` to
force) and the dashboards and `tumwater role <id>` say which roles read images and where a blind
run reroutes.

Every command, flag, and TUI key is in [docs/cli.md](docs/cli.md); `tumwater help` prints the
same list, and `tumwater completion bash|zsh|fish` prints shell completion. Settings live in
`tumwater.json` and edits apply live while the team runs; see [docs/config.md](docs/config.md).

**Backends:** any OpenAI-compatible model pi can reach works, chosen by `model` in `tumwater.json`
with a `fallback` that a failing role switches to. `backend` beside `model` picks who runs it:
`"backend": "claude"` runs a model id on Claude Code, `"backend": "opencode"` on the OpenCode CLI — its free
DeepSeek tier needs no login or API key. Requirements, the fallback, free-ness, and usage-window
behavior, and how subscription runs are billed (as estimated spend, outside the daily cap) are in
[docs/backends.md](docs/backends.md).

**Mixing providers:** `model` says which model, `backend` says which program runs it (`pi`, the
default, `claude` or `opencode`). A tier entry, a role, a review and a fallback step each take an
object with both, so one config can mix a Claude strong tier with pi providers:

```json
{
  "model": {
    "default": "huggingface/deepseek-ai/DeepSeek-V4.1-Flash:deepinfra",
    "strong": { "backend": "claude", "model": "claude-opus-5-5" }
  },
  "fallback": "omlx/Qwen3.8-27B-MLX-oQ4e-mtp"
}
```

The default tier runs on pi through Hugging Face, the strong model jobs (the director, the plan
role, the reviewer, and the conflict resolver) run on the claude CLI's included usage, and the fallback runs on pi through
oMLX — all concurrently, under each provider's cap (set it with `maxConcurrentPerProvider`;
`tumwater status` shows how many runs each key has going out of its cap). An OpenCode tier is
`{ "backend": "opencode", "model": "deepseek-v4.1-flash-free" }`, so its free tier can sit beside pi
and claude in one config; a Claude model that should stay on pi (billed per token) is the plain
`anthropic/claude-…` selector. See [plans/agent-backends.md §3](plans/agent-backends.md).

For how the roles, review gate, scheduling, and updates work, see
[docs/how-it-works.md](docs/how-it-works.md). For a measured comparison of tumwater's own
code against human-written open source, see [docs/code-metrics.md](docs/code-metrics.md).

## Appendix: the brief

The brief this repository was started from, kept for history. tumwater still reads the brief from
between the markers below on every run.

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
