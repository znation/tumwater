# tumwater

An opinionated autonomous development harness built on [pi](https://github.com/badlogic/pi-mono).
You write the initial prompt; a fleet of role-driven loops builds the project with immense effort.

![The tumwater web dashboard: the loop fleet mid-run, with live per-loop state, tick/commit/token counts, last results, the event feed, and the director prompt box](docs/gui.png)

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
v0.1: working harness. Commands: `init`, `run`, `tui`, `gui` (`--port N`, `--all-interfaces`),
`status`, `logs` (`-f`, `--role <id>`, `-n N`), `prompt "text"` / `prompt --list` /
`prompt --cancel <n>`, `reset-counters [--role <id>]`, and `abort --role <id>` (kills one loop's
in-flight tick; work discarded, the loop keeps running). All twelve roles — feature, bugfix, plan,
readme, organize, coverage, clean, dry, perf, qa (~2 h clock), improve, steward (~6 h clock) — plus
the director are enabled by default.

Open items:
- Planned (PLANS.md): section-aware tick reads — bound per-tick prefill by reading only the
  actionable top sections of PLANS.md/BUGS.md instead of the whole files (planned 2026-09-04).
- Open bugs: none. Open questions: none (this repo tracks no QUESTIONS.md; `init` seeds one for
  new projects).

Current main (`1cc03b9`): build clean, suite 610/610, verified 2026-09-04.
<!-- tumwater:status:end -->

## How it works

`tumwater init "<prompt>"` seeds a git repo with README.md (your prompt + a status section),
PLANS.md, BUGS.md, QUESTIONS.md, PRINCIPLES.md, and tumwater.json, and commits them. `tumwater run` then starts
one loop per enabled role. Every loop tick:

1. Resets its persistent worktree (`.tumwater/worktrees/<role>`, branch `tumwater/<role>`) to main.
2. Builds a role-specific "find something to do" prompt and runs `pi --print --mode json` in the
   worktree, starting a FRESH pi session every tick: context never accumulates across ticks, so
   ticks start with a small, cheap prefill and stay far from the model's context window. Durable
   knowledge lives in the repo itself (README/PLANS/BUGS/QUESTIONS, read at the start of every tick), not
   in model context.
3. If pi changed files: commits, then runs an adversarial review gate over the full ahead-of-main
   diff — first a deterministic build pre-check (the project's declared verify script: `npm test`
   when declared, else typecheck/build; failure rejects without spending a model run), then a
   fresh-session reviewer against PRINCIPLES.md that replies `VERDICT: approve|reject` (md-only
   diffs are exempt); rejects reset the branch with reasons injected into the author's
   next tick, failures keep the commit for re-review under a 3-strike discard cap. Approved work
   rebases the branch onto main (so main's history stays linear) and fast-forwards — all under a
   merge lock shared by every loop. If pi found nothing to do, the loop backs off (exponentially,
   capped) and sleeps.
4. Sleeping loops wake early when main moves — the world changed, so the answer may have changed.

The fleet's autonomous spend is capped by `maxDailyCostUsd` (default $50; set 0 to disable).
While the day's total cost has reached the cap, role loops stop starting new ticks — scheduled,
main-moved wakes, or startup — until local midnight or a live edit raises/disables the cap;
in-flight ticks finish and the director stays exempt (its spend still counts toward the cap).
Each transition lands as one `budget_paused`/`budget_resumed` event, visible in `tumwater logs`,
the TUI activity pane, and the GUI feed.

Every tick prompt also carries the project's `PRINCIPLES.md` — its design principles, the codified
answer to "what would a senior engineer on this team always do" — so all loops share one standard of
taste. Only the director and steward roles edit that file; every other loop treats it as read-only.

Stopping the harness (Ctrl+C) mid-tick loses nothing: the interrupted loop's pi session and its
worktree's uncommitted edits stay in place, and on the next `tumwater run` that loop resumes the
same session (`--continue`) with a short bridge prompt and finishes the task it was on. A crash
(power loss, kill -9) is recovered the same way — except an interruption during the review gate,
where the work is already committed and the next launch recovers and re-reviews it via a fresh
tick instead of resuming the author session. The director is the exception: its interrupted
user prompt goes back into the inbox and runs fresh.

The director loop is special: it executes prompts you type into the TUI (or `tumwater prompt`),
queued in a file-based inbox. It always has priority — a queued prompt starts immediately,
outside the `maxConcurrent` limit and ahead of every role loop, and queued prompts run back to
back with no cooldown between them. Everything is local git; no remotes are ever touched. Runtime state
lives in `.tumwater/` (gitignored); durable state (plans, bugs, questions, principles, status, config) lives
in tracked markdown and `tumwater.json`.

## Usage

```
npm install && npm run build

cd your-project        # any git repo
tumwater init "Build a tiny markdown-to-html converter CLI in Python."
tumwater run          # terminal 1: the loops (Ctrl+C to stop)
tumwater tui          # terminal 2: dashboard + main prompt
tumwater gui          # or the same dashboard at http://127.0.0.1:7180 (--port N to change)
tumwater gui --all-interfaces      # serve the dashboard to the whole network (see below)
tumwater status       # one-shot table
tumwater logs -f      # follow harness events
tumwater logs --role feature   # that loop's pi transcript (also supports -f, -n N)
tumwater prompt "prefer no third-party deps"
tumwater prompt --list             # show queued prompts, numbered in execution order
tumwater prompt --cancel <n>       # remove the Nth queued prompt (as shown by --list)
tumwater reset-counters            # zero ticks/commits/tokens/cost (a running fleet picks it up within ~2s)
tumwater reset-counters --role feature   # …or just one loop
tumwater abort --role feature      # kill that loop's in-flight tick now (work discarded; the loop keeps running)
```

`reset-counters` starts a fresh observation window (e.g. "cost since today") without touching
scheduling, backoff, or pi session continuity — loops keep sleeping and waking exactly as before.

`gui --all-interfaces` binds every network interface (IPv4 and IPv6) instead of localhost, and
prints the LAN URLs it is reachable at. The dashboard has **no authentication**, and its prompt
box feeds the director — anyone who can reach the port can steer the fleet and read every
transcript. Use it only on networks where that is acceptable.

Roles: `feature`, `bugfix`, `plan`, `readme`, `organize`, `coverage`, `clean`, `dry`, `perf`,
`qa`, `improve`, `steward`, `director`. Enable/disable them, pick pi's provider/model/thinking
level, set a per-role tick interval (the steward runs on a ~6 h clock and qa on a ~2 h clock,
both by default), and tune backoff in
`tumwater.json`. While the harness is running, edits to `tumwater.json` are picked up
within ~2s — every setting applies live: enabling/disabling roles, per-role provider/model/
thinking/instructions, tick intervals, backoff, the `maxConcurrent` cap, and
`sessionRetentionDays` (a mid-run edit re-prunes immediately).

Spend is capped by `maxDailyCostUsd` in tumwater.json (default 50; set 0 to disable): once the
day's total cost across all loops reaches it, role loops stop starting new ticks for the rest of
the local day — in-flight ticks finish and the director keeps running your prompts. Edits apply
live within ~2s.

## Notes on local model servers

- **LM Studio WARN flood** (`Reasoning setting 'high' is not supported by model '…'. Supported
  settings: 'on', 'off'. Falling back to reasoning setting 'on'.`): benign. pi requests its
  configured thinking level per turn; GGUF models that only expose an on/off reasoning toggle make
  LM Studio warn and fall back to `on`. Reasoning stays enabled; no tumwater or pi change needed.
  To silence it, set a thinking level the model supports (or none) in `tumwater.json` / pi settings.
- **"terminated" tick errors after ~20 minutes**: pi's HTTP client (undici) applies an idle
  timeout (`httpIdleTimeoutMs` in pi's settings.json, default 300000 = 5 min) to both response
  headers and gaps between body chunks. A local server prefilling a large context under
  concurrent load can take longer than that to stream its first byte, so the request is severed
  ("terminated"), pi's retries die the same way, and the tick fails after ~4 × 5 min. Fix: set
  a large-but-finite `"httpIdleTimeoutMs"` (e.g. `1800000` = 30 min) in
  `~/.pi/agent/settings.json`. Do not use `0` (fully disabled): a zombie socket then waits
  forever. The harness's `quietTimeoutSeconds` watchdog (default 30 min; kills a run when no
  *progress* — message, turn, and tool boundary events — happens, so content-free keepalives
  cannot reset it) and `tickTimeoutSeconds` remain the layered hang guards.
- **Context accounting**: declare an honest `contextWindow` for the model in pi's `models.json` —
  it is what triggers pi's auto-compaction. With LM Studio's unified KV cache, concurrent requests
  share one context pool (declare pool ÷ slots); with unified KV off, each slot owns the full
  window. A session that overruns the server's real limit fails with "Context size has been
  exceeded"; since every tick runs a fresh session, the next tick is unaffected.
- **Truncated-at-the-ceiling turns look like normal stops**: as a session nears the declared
  `contextWindow`, pi clamps each request's `max_output_tokens` to the space remaining (down
  to a floor of 16). LM Studio's `/v1/responses` reports a generation stopped by that clamp
  as status `completed` rather than `incomplete`/`max_output_tokens`, so pi sees stopReason
  "stop" instead of "length" and its compact-and-retry overflow handling never fires — the
  turn ends mid-thought with no text and no tool call, the agent loop finishes, and the tick
  lands as `no_change` with a "finished without changes and without declaring nothing-to-do"
  warning (now annotated with "likely cut off at the context ceiling"). Prevention: tumwater
  starts every tick in a fresh session, so ticks begin with only the prompt (~8k tokens) and
  need ~75k of within-tick growth to reach the cliff — several hours of dense work. Note that
  pi never compacts MID-run (only at end of run), so a single extremely long tick can still
  hit the cliff; the tick then ends with the warning above, any files pi already edited are
  still committed, and — when no changes landed — the loop does not idle-backoff: its next
  tick resumes the session pi just compacted at end of run (short bridge prompt, same task),
  effectively mid-task compaction at tick granularity. After 3 consecutive cut-offs on one
  task it gives up and falls back to a fresh tick with normal backoff; a cut-off director
  prompt is re-queued and reruns fresh.
- **Match clients to slots, or prefix caches thrash**: each server slot keeps the KV prefix of
  the last request it served. Keep the number of concurrent tumwater clients — `maxConcurrent`
  plus one for the director's bypass — at or below the server's slot count. One client over, and
  slots keep evicting each other's session prefixes: with persistent multi-10k-token sessions,
  nearly every turn re-prefills from scratch (minutes each), requests queue behind those
  prefills, and starved ticks die as "no pi progress" watchdog kills even though the server is
  healthy. Symptom to look for: small-context requests timing out while the server log shows
  continuous back-to-back prompt processing.
- **Use unified KV cache; unified-off serves requests serially**: with unified KV disabled,
  the engine was observed serving one request at a time regardless of the parallel-slot setting —
  the server log shows strictly alternating "Finished streaming response" / "Running chat
  completion" lines, and a queued request can starve for 30+ minutes behind other loops' turns
  (dying as a "no pi progress" watchdog kill seconds before its first token). Unified-on gives
  genuinely interleaved streams. The stable configuration for this setup: unified KV **on**,
  full context pool (e.g. 262144), parallel = slot count, pi `contextWindow` = pool ÷ slots so
  auto-compaction keeps concurrent sessions inside the pool.
- **KV memory with dedicated slots**: unified-off KV buffers are also allocated per slot — for a
  27B model, 4 × 262144-token slots cost ~100 GB of KV on top of the weights (~115 GB total),
  which runs a 128 GB machine at the edge: heavy swapping, and the engine can wedge permanently
  in `PROCESSINGPROMPT` (predictions hang, API reports "Engine protocol predict request failed:
  fetch failed", `lms ps` shows a phantom prefill). Unified-on at the same pool is ~25 GB.
  Recover a wedged engine with `lms unload <model>` + `lms load <model> --context-length N
  --parallel K`.

## Development

```
npm test               # build + unit tests (node:test)
```

Layout: `src/` harness code (`loop.ts` is the tick lifecycle, `orchestrator.ts` the scheduler,
`pi.ts` the pi subprocess integration, `git.ts` the git/worktree helpers, `merge.ts` the
rebase/fast-forward/conflict-resolution landing flow), `test/` unit tests.
Tests fake pi with a shell shim on PATH, so they run offline.
