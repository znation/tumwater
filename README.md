# tumwater

tumwater is an opinionated autonomous development harness built on
[pi](https://github.com/badlogic/pi-mono). You write a short project brief, and a fleet of
role-driven loops (feature, bugfix, planning, tests, cleanup, docs, and more) builds the project
one small, reviewed commit at a time. It came from wanting to write only the brief and let a team
of always-on specialists do the rest: each loop owns one concern, lands one change per tick,
sleeps when it has nothing to do, and wakes when main moves. All project state lives in the
local git repo, and no remote is ever touched.

![The tumwater web dashboard running tumwater's own fleet: a sidebar with the project, its fleet status, the Fleet, History, Usage, Failures, and Settings views, today's spend against the cap, and the pause control; an alert that the running build is behind main; the director prompt box; today's progress (loops in flight, commits landed, ticks, open backlog); and the loops grouped by what they are doing, each with its status, current work or last result, spend, and controls](docs/gui.png)

## Install

Requires Node 20.3 or later on macOS or Linux.

```bash
npm install -g tumwater
```

Or run any command without installing: `npx tumwater`. To run from a checkout of this repo
instead: `npm install && npm run build && npm link`.

With `claude` installed and logged in, `npm run smoke:claude` is an opt-in live check of the
claude backend: it drives the real CLI through a throwaway repo (a few cents of API-equivalent
spend on a subscription) and is not part of `npm test`, which stays green without claude.

## Status

<!-- tumwater:status:start -->
**v0.1.4**: working harness. The director and 14 of the 15 roles are enabled by default; `telemetry`,
which files harness bugs from tumwater's own event log, is opt-in (`roles.telemetry.enabled`).

Open work: [PLANS.md](PLANS.md) (planned), [BUGS.md](BUGS.md) (open bugs),
[QUESTIONS.md](QUESTIONS.md) (open questions).
<!-- tumwater:status:end -->

## Usage

```bash
cd your-project                 # a new or existing directory
tumwater init "Build a tiny markdown-to-html converter CLI in Python."
                                # --template, --file, and --adopt pick a starting point (see docs/cli.md)
tumwater start                  # start the team (Ctrl+C to stop); `tumwater run` is an alias
tumwater start --gui            # ... and serve the browser dashboard at http://127.0.0.1:7180
tumwater start --tui            # ... and attach the terminal TUI in the same window
tumwater start --for 2h         # run for a bounded window, then drain, summarize, and exit
tumwater start --once           # one round of runs for cron/CI; exits 3 if a run failed
```

A fresh or empty project is seeded with `"bootstrap": {"untilPlansDone": 5}`, which holds the
maintenance loops until 5 plans are done; remove it from `tumwater.json` to end that early.

From another terminal, `tumwater tui` or the browser dashboard watches the fleet, `tumwater status`
and `tumwater logs -f` check it, `tumwater brief --file <path>` replaces the initial prompt,
`tumwater prompt "<text>"` queues a request for the director, `tumwater plan` and `tumwater bug`
file backlog entries, and `tumwater pause`, `resume`, `wake`, and `stop` control the loops.
`tumwater doctor` audits the fleet and `tumwater report` shows usage and cost. `gui
--all-interfaces` exposes the dashboard, and with it the director prompt, to your whole network,
so pair it with `--token <secret>`.

`tumwater prompt --attach <image>` gives a loop an image to read at its next tick. When a loop's
model cannot read images, the command refuses the attachment up front (naming the fix) unless
the loop reroutes a blind read to a vision model, in which case it says where the prompt will run;
`tumwater doctor` probes each claimed image-input model once (cached 7 days, `--reprobe` to force)
and the dashboards and `tumwater role <id>` say which loops read images and where a blind tick
reroutes.

Every command, flag, and TUI key is in [docs/cli.md](docs/cli.md); `tumwater help` prints the
same list, and `tumwater completion bash|zsh` prints shell completion. Settings live in
`tumwater.json` and edits apply live while the fleet runs; see [docs/config.md](docs/config.md).

**Backends:** any OpenAI-compatible model pi can reach works, chosen by `model` in `tumwater.json`
with a `fallback` that a failing role switches to. `backend: "claude"` runs bare selectors on Claude
Code instead. Requirements, the fallback and usage-window behavior, and how subscription runs are
billed (as notional spend, outside the daily cap) are in [docs/backends.md](docs/backends.md).

**Mixing providers:** a bare model id that starts with `claude-` runs on the claude CLI even
under the default `backend: "pi"`, so one config can mix a Claude strong tier with pi providers:

```json
{
  "model": {
    "default": "huggingface/deepseek-ai/DeepSeek-V4.1-Flash:deepinfra",
    "strong": "claude-opus-5-5"
  },
  "fallback": "omlx/Qwen3.8-27B-MLX-oQ4e-mtp"
}
```

The default tier runs on pi through Hugging Face, the strong seams (the reviewer and the
conflict resolver) run on the claude CLI's included usage, and the fallback runs on pi through
oMLX — all concurrently, under each provider's cap (set it with `maxConcurrentPerProvider`;
`tumwater status` shows each key's slots in use out of its cap). Prefix `anthropic/` (`anthropic/claude-…`)
to keep a Claude model on pi instead (billed per token). See [plans/agent-backends.md §3](plans/agent-backends.md).

For how the loops, review gate, scheduling, and self-redeploy work, see
[docs/how-it-works.md](docs/how-it-works.md). For a measured comparison of tumwater's own
code against human-written open source, see [docs/code-metrics.md](docs/code-metrics.md).

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
