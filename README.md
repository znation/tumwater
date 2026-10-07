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

## Status

<!-- tumwater:status:start -->
**v0.1.1**: working harness. All 15 roles and the director are enabled by default.

Open work: [PLANS.md](PLANS.md) (planned), [BUGS.md](BUGS.md) (open bugs),
[QUESTIONS.md](QUESTIONS.md) (open questions).
<!-- tumwater:status:end -->

## Usage

```bash
cd your-project             # a new or existing directory
tumwater init "Build a tiny markdown-to-html converter CLI in Python."
                            # add --template <id> to seed from a bundled starting point
                            # (blank, python-cli, node-cli, static-site); --list-templates
                            # prints the catalog
                            # add --file <path> to read the brief from a file
                            # add --adopt to adopt an existing repo as-is
tumwater run                # start the loops (Ctrl+C to stop)
tumwater run --gui          # ... and serve the browser dashboard at http://127.0.0.1:7180 from the same process
tumwater run --for 2h       # run for a bounded window (capped at 90d), then drain and exit like Ctrl+C would
```

Then, from another terminal:

| To | Run |
| --- | --- |
| Watch the fleet | `tumwater tui`, or the browser dashboard at http://127.0.0.1:7180 — `tumwater gui` on its own, or `tumwater run --gui` to boot the fleet and the dashboard together |
| Watch per-tick history | `tumwater history [--role <id>] [-n N] [--since <duration>] [--grep <text>]`, or `tumwater history --json` for the rows as JSON; `tumwater tick <role> <n>` for one tick's full event trail (a summary header — when it ran, how long, result, usage — followed by the tick's events, oldest first; `--last` shows the newest completed tick's trail instead of numbering one; `--json` prints the payload as JSON, `null` when the log holds no such tick) |
| Check state | `tumwater status`, `tumwater logs -f`, `tumwater logs --since <duration>`, `tumwater logs --grep <text>`, `tumwater logs --json` (the event feed as NDJSON, for scripts), `tumwater logs --role <id>`, `tumwater backlog` (planned features, open bugs, open questions as Markdown), `tumwater backlog --json` (the backlog as JSON, for scripts), `tumwater role <id>` (one loop's standing prompt — find text, `instructions` override, resolved model and interval, enabled/paused state, its notebook — plus its next tick's assembled prompt, which shows the oldest queued prompt without consuming it (one is dequeued per tick; `--json` for scripts)) |
| See a loop's pending change | `tumwater diff --role <id>` — that loop's branch's unlanded commits (with the patch) and its worktree's uncommitted edits (staged and unstaged); without `--role`, one line per loop holding pending work; `--json` prints the payload as data |
| Steer the project | `tumwater prompt "prefer no third-party deps"` queues a request for the director; add `--role <id>` to aim it at one loop's next tick, `--file <path>` (`-` for stdin) to read the text from a file, or `--at <duration>` to defer it until the duration passes (45s, 90m, 1h30m, 1d; capped at 90d), `tumwater prompt --list` shows the queued prompts numbered and grouped by loop, with how long each has waited (`--json` for scripts), and `tumwater prompt --cancel <n>` removes the Nth entry as `--list` shows them, and `tumwater prompt --edit <n> "new text"` rewrites the Nth entry in place, keeping its position and wait time (both take `--role <id>` when several loops share that number), and `--attach <path>` (repeatable, up to 4 images — png, jpg, jpeg, gif, webp, bmp, each at most 5 MiB) attaches an image the receiving loop reads at its next tick; `tumwater bug "<symptom>"` files a bug into BUGS.md's Open section and wakes the bugfix loop, `tumwater plan "<title>" [body...]` files a plan request into PLANS.md's Planned section and wakes the feature loop — both stamped as operator-reported (the other half of `tumwater backlog`) |
| Answer open questions | `tumwater questions` lists QUESTIONS.md's open questions numbered (as the loops wrote them); `tumwater questions answer <n> "decision text"` moves the Nth entry to ## Answered with your dated answer (loops read the file back on their next tick); `--json` prints the list as data |
| Control the loops | `tumwater pause [--for <duration>]` / `resume [--role <id>]` (fleet or one loop; `--for 2h` auto-resumes, capped at 90d; add `--reason <text>` on a fleet pause to state why — it shows on `status`, the TUI, and the dashboard), `tumwater wake` (skip backoff; `wake --in 45m` schedules the wake for 45 minutes from now — the marker is written immediately but consumed no earlier than the deadline, like `pause --for`'s auto-resume), `tumwater retire --role <id>` (remove a disabled loop's worktree, branch, and per-role state — use after setting `enabled: false` for that role; `--force` overrides the safety rails), `tumwater abort --role <id>`, `tumwater stop` (drain and exit, like Ctrl+C), `tumwater reset-counters [--role <id>]` (zero the per-loop counters the dashboards show, starting a fresh observation window — scheduling is untouched) |
| Audit | `tumwater doctor` (pre-flight; `--json` prints the report as JSON, for scripts), `tumwater report` (usage and cost; totals include landing runs — reviewer + conflict resolution), `tumwater report --since <duration>` (totals over a trailing window, capped at 7d), `tumwater report --json` (the `--days`/`--since`/`--failures` reports as JSON, for scripts), `tumwater report --failures` (the failure digest: per-role outcomes, each role's time and spend by outcome, and the top five loss causes ranked by agent-hours, with a marker naming how many were cut) |

`tumwater help` lists every command and flag; `tumwater help <command>` shows one command's usage. `gui --all-interfaces` exposes the dashboard, and
with it the director prompt, to your whole network, so pair it with `--token <secret>`.

Settings live in `tumwater.json`: enabled roles, model (either one selector or a map of tiers
`small`/`default`/`strong` — omitted tiers inherit `default`; per-tier `fallback` overrides may name a
model or `"pause"`, and a role's `model` may name a tier; see [plans/model-tiers.md](plans/model-tiers.md)),
intervals, the daily spend cap
(`maxDailyCostUsd`, with optional per-role caps `maxDailyCostUsdPerRole` — a loop over its own
cap starts no new ticks until the next local day or a live edit), a nightly `quietHours` window
(e.g. `"23:00-07:00"` local time) during
which role loops start no new ticks (the director is exempt), with optional per-role windows
`quietHoursPerRole` — a loop inside its own window starts no new ticks, whether or not the
fleet-wide window covers now — a `diskHoldGB` free-space floor (default 10; when the volume
holding the worktrees drops below it, no new work starts until free space recovers 5 GB above it;
0 disables) and a `diskReclaimGB` pressure-reclaim threshold (default 40; below it idle worktrees
drop their gitignored build outputs before the hold engages; 0 disables) — user-defined
`customLoops`, and an
optional `notify` shell command run when the fleet needs a human (a budget pause, a budget warning
at 80% of the cap while the gate is still open, an error-streak
breaker trip, a failed landing, a blocked restart — the command gets `TUMWATER_EVENT_TYPE`,
`TUMWATER_EVENT_LOOP`, and `TUMWATER_EVENT_MESSAGE` in its environment).
Edits apply live while the fleet runs.
From the terminal, `tumwater config` prints the effective config as JSON, `tumwater config get
<key>` reads one resolved value, and `tumwater config set <key> <value>` writes one top-level
key; dotted keys (`maxDailyCostUsdPerRole.feature 1.5`, `roles.qa.model x`) merge one entry
into the existing map or role entry, while bare keys replace the whole value.

**Backends:** any OpenAI-compatible model pi can reach works; set `model` in `tumwater.json` to
one `provider/id[:thinking]` selector (plus `fallback` to a free selector), or a map of tiers
`small`/`default`/`strong`. A role whose primary keeps failing with provider-class errors
(three consecutive 429s or backend failures) runs its next ticks on its tier's resolved
`fallback` pair and probes the primary once the 5-minute cooldown elapses, returning to it
when a probe answers; `tumwater status`, the TUI, the dashboard, and `tumwater role <id>` name
the off-model episode. See [docs/backends.md](docs/backends.md) for requirements and a
worked setup.

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
