# tumwater

An opinionated autonomous development harness built on [pi](https://github.com/badlogic/pi-mono).
You write the initial prompt; a fleet of role-driven loops builds the project with immense effort.

![The tumwater web dashboard: the loop fleet mid-run, with live per-loop state, tick/commit/token counts, last results, the shared backlog of planned features and open bugs, the event feed, and the director prompt box](docs/gui.png)

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
`status` (`--json`), `report` (`--days N`; Markdown usage report, default 14 days),
`doctor` (pre-flight check of git, repo, config, pi, locks, and build — read-only,
exits 0/1 so it can be scripted), `logs` (`-f`, `--role <id>`, `-n N`), `prompt "text"` /
`prompt --list` / `prompt --cancel <n>`, `reset-counters [--role <id>]`, `abort --role <id>`
(kills one loop's in-flight tick; work discarded, the loop keeps running), and `pause` /
`resume` (operator-intent fleet gate: role loops stop starting new ticks while in-flight ones
finish; the director keeps running). All twelve roles —
feature, bugfix, plan, readme, organize, coverage, clean, dry, perf, qa (~2 h clock), improve,
steward (~6 h clock) — plus the director are enabled by default. While main's build/test suite is
red, code-producing roles skip their authoring run and show a `main red` state in both dashboards
until main is green again (director, bugfix, and the markdown-only roles keep ticking — bugfix can
land the fix).

Open items:
- Planned: make the daily cost budget editable from the TUI/GUI (TUI Ctrl+B; GUI badge
  click-to-edit; one shared setter + `POST /api/budget`; planned 2026-09-07).
- Planned: user-defined loops — sub-plans 1/3–3/3 tracked in PLANS.md; first is `customLoops`
  config plumbing, then the director control surface and dashboard markers (planned 2026-09-07,
  split 2026-09-08).
- Planned: per-loop token generation rate column in the TUI/GUI — a 5-minute moving average shown
  for loops with an in-flight tick, `-` otherwise (planned 2026-09-08).
- Planned: harness-level merge queue — sub-plans 2/5–5/5 tracked in PLANS.md (1/5 landed);
  next is landing in a per-role detached worktree (planned 2026-09-08).
- Planned: show the GUI loop table's last tick with relative age, matching the TUI's
  "· Nm ago" cell format (planned 2026-09-11, requested by user).
- Open bugs: the TUI/GUI `reviewing` state shows only elapsed time — no turn/ctx/tool detail
  like the `working` state does (reported by user 2026-09-11; fix direction pinned in BUGS.md).
- Open questions: none (this repo tracks no QUESTIONS.md; `init` seeds one for new projects).

Current main (`207983f`): build clean, suite 886/886, verified 2026-09-12.
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
3. If pi changed files: commits (a reply without the SUMMARY block gets one follow-up turn in
   the same session to produce it; failing that the subject names the changed files), then runs
   an adversarial review gate over the full ahead-of-main
   diff — first a deterministic build pre-check (the project's declared verify script: `npm test`
   when declared, else typecheck/build; failure rejects without spending a model run), then a
   fresh-session reviewer against PRINCIPLES.md that replies `VERDICT: approve|reject` (md-only
   diffs are exempt); rejects reset the branch with reasons injected into the author's
   next tick, failures keep the commit for re-review under a 3-strike discard cap. Approved work
   rebases the branch onto main (so main's history stays linear), re-runs the declared check on
   the rebased tree when main moved under it, and fast-forwards — all under a merge lock shared
   by every loop. If pi found nothing to do, the loop backs off (exponentially,
   capped) and sleeps.
4. Sleeping loops wake early when main moves — the world changed, so the answer may have changed.

Scheduling is need-aware: a maintenance role's due tick (scheduled or main-moved) is deferred —
one `tick_deferred` event per episode in logs, TUI, and GUI — while its last tick did nothing
and no feature/bugfix/director/human commit has landed on main since; it starts within one poll
of such work landing. Slot allocation orders the work roles (feature, bugfix, plan) ahead of
every maintenance role, least-recently-ticked first within a tier.

The fleet's autonomous spend is capped by `maxDailyCostUsd` (default $50; set 0 to disable).
While the day's total cost has reached the cap, role loops stop starting new ticks — scheduled,
main-moved wakes, or startup — until local midnight or a live edit raises/disables the cap;
in-flight ticks finish and the director stays exempt (its spend still counts toward the cap).
The operator-intent sibling is `tumwater pause` / `resume`: a persistent marker that blocks new
role ticks (same wake reasons, same director exemption) until lifted. Each gate transition lands
as one `budget_paused`/`budget_resumed` or `fleet_paused`/`fleet_resumed` event, visible in
`tumwater logs`, the TUI activity pane, and the GUI feed.

Every tick prompt also carries the project's `PRINCIPLES.md` — its design principles, the codified
answer to "what would a senior engineer on this team always do" — so all loops share one standard of
taste. Only the director and steward roles edit that file; every other loop treats it as read-only.

The prompts are written for the fleet's real model — a mid-sized local model (a ~27B Qwen-class
model with thinking on) behind a large but finite window: rules are grouped, with numeric budgets
(choose the task within ~15 tool calls; check a file's size before reading it whole; read anything
over ~300 lines in ranges; the reply ends with plain text, never an announced next step). Roles with
no backlog to point at (`organize`, `clean`, `dry`, `perf`, `improve`) carry a shortlist-and-decide
search procedure — cheap signals such as recent churn, size outliers, and targeted grep, with their
own recent commits as the memory of what they already did — instead of surveying the codebase file
by file, which is what filled the window on half of all ticks before. Plans are sized to one
implementation run so the feature loop can land them whole, and the reviewer works through a
five-point checklist and is told when the gate's deterministic pre-check already passed, so it
spends its run on what a green suite cannot show rather than re-running it.

Stopping the harness (Ctrl+C) mid-tick loses nothing: the interrupted loop's pi session and its
worktree's uncommitted edits stay in place, and on the next `tumwater run` that loop resumes the
same session (`--continue`) with a short bridge prompt and finishes the task it was on. A crash
(power loss, kill -9) is recovered the same way — except an interruption during the review gate,
where the work is already committed and the next launch recovers and re-reviews it via a fresh
tick instead of resuming the author session. The director is the exception: its interrupted
user prompt goes back into the inbox and runs fresh.

`npm run build` stamps `dist/build-info.json` with the commit it compiled, and the orchestrator
records that stamp in its start event and in `.tumwater/state/orchestrator.json`. When the project
being built IS tumwater (dogfood), the harness compares the stamp against main whenever main
moves: a `build_stale` event fires the first time main's `src/`, `package.json`, or
`tsconfig.json` differ from the running code, both dashboards show `STALE: main +N` in the
header, and `tumwater doctor` warns. With `autoRestart` (default true) the fleet then redeploys
itself: it verifies main is green (a green verdict seeded by the landing path — its post-rebase
check at merge time, or one run of the suite in a detached `_main` worktree), compiles main into
`.tumwater/build/<sha>` with the project's own
tsc — borrowed from the nearest ancestor install, since no worktree has one of its own — stops
starting new ticks while in-flight ones finish (role ticks up to 30 minutes, counted across the
whole hold even when main moves again meanwhile, after which they are aborted resuably; an in-flight
director tick is waited for without a cap — a human prompt outranks the redeploy), swaps the compiled tree into `dist/`, and exits so the `tumwater run` supervisor — the
process you started, which runs the orchestrator as a child — respawns it on the new code.
Completed auto-restarts are rate-limited to at most one per 12 h: inside that cooldown STALE
stays visible with a `restart BLOCKED: cooldown until …` deadline and ticks continue on the stale
build, so sustained churn cannot halt the fleet for a drain over and over. A green
verdict is reused fleet-wide; a red one is re-run in the mirror first, because a suite can fail
for reasons that belong to a worktree rather than to the tree. A red main or a failed compile
leaves the old build running until main moves again — a warning event, and `restart BLOCKED:
<reason>` in both dashboard headers and `tumwater doctor`, so a restart that will never happen
does not look like one that is seconds away.

The director loop is special: it executes prompts you type into the TUI (or `tumwater prompt`),
queued in a file-based inbox. It always has priority — a queued prompt starts immediately,
outside the `maxConcurrent` limit and ahead of every role loop, and queued prompts run back to
back with no cooldown between them. Everything is local git; no remotes are ever touched. Runtime state
lives in `.tumwater/` (gitignored); durable state (plans, bugs, questions, principles, status, config) lives
in tracked markdown and `tumwater.json`.

## Usage

```
npm install && npm run build

cd your-project        # existing or new project dir
tumwater init "Build a tiny markdown-to-html converter CLI in Python."
tumwater run          # terminal 1: the loops (Ctrl+C to stop)
tumwater tui          # terminal 2: dashboard + main prompt
tumwater gui          # or the same dashboard at http://127.0.0.1:7180 (--port N to change)
tumwater gui --all-interfaces      # serve the dashboard to the whole network (see below)
tumwater status       # one-shot table
tumwater status --json   # machine-readable fleet state (same payload as the GUI's /api/status)
tumwater report [--days N]   # Markdown usage report — tokens/ticks/commits per day (default 14 days)
tumwater doctor       # pre-flight check: git, repo, config, pi, locks, build (read-only; exit 0/1)
tumwater logs -f      # follow harness events
tumwater logs --role feature   # that loop's pi transcript (also supports -f, -n N)
tumwater prompt "prefer no third-party deps"
tumwater prompt --list             # show queued prompts, numbered in execution order
tumwater prompt --cancel <n>       # remove the Nth queued prompt (as shown by --list)
tumwater reset-counters            # zero ticks/commits/tokens/cost (a running fleet picks it up within ~2s)
tumwater reset-counters --role feature   # …or just one loop
tumwater abort --role feature      # kill that loop's in-flight tick now (work discarded; the loop keeps running)
tumwater pause                     # stop role loops starting new ticks (in-flight finish; the director keeps running)
tumwater resume                    # lift a fleet pause
```

`reset-counters` starts a fresh observation window (e.g. "cost since today") without touching
scheduling, backoff, or pi session continuity — loops keep sleeping and waking exactly as before.

Review-gate runs are labeled in loop transcripts: each role's raw log interleaves author ticks
and reviewer runs, and review runs render as `── review @ <timestamp> ──` in `tumwater logs
--role`, the TUI transcript pane, and the GUI detail panel.

`gui --all-interfaces` binds every network interface (IPv4 and IPv6) instead of localhost, and
prints the LAN URLs it is reachable at. The dashboard has **no authentication**, and its prompt
box feeds the director — anyone who can reach the port can steer the fleet and read every
transcript. Use it only on networks where that is acceptable.

Roles: `feature`, `bugfix`, `plan`, `readme`, `organize`, `coverage`, `clean`, `dry`, `perf`,
`qa`, `improve`, `steward`, `director`. Enable/disable them, pick pi's provider/model/thinking
level, set a per-role tick interval (by default the steward runs on a ~6 h clock, qa on ~2 h,
readme on 30 min and plan on 1 h — the bookkeeping roles batch a burst of landings into one sync
instead of restamping after every merge), and tune backoff in
`tumwater.json`. While the harness is running, edits to `tumwater.json` are picked up
within ~2s — every setting applies live: enabling/disabling roles, per-role provider/model/
thinking/instructions, tick intervals, backoff, the `maxConcurrent` cap, `autoRestart`, and
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
- **A unified KV pool cannot exceed the model's training context; dedicated slots can grow per
  stream**: with unified KV on, llama.cpp treats the shared pool as the slot context and caps it at
  `n_ctx_train` — asking Qwen3.8-27B for 524288 logs "the slot context exceeds the training context
  of the model — capping" and comes up as 262144 — so per-stream headroom under unified KV is
  pool ÷ slots and can never grow past that. For a larger window per stream, turn unified KV
  **off** and set the context length per slot. Measured 2026-09-07 with 3 × 174080-token slots
  (~64 GB wired, ~110 KB of KV per token on this model): three concurrent streams interleave at
  8.3–8.4 tok/s each, aggregate 24.8 tok/s — identical to unified-on, and equal to a single
  stream's 24.2, because the GPU is the bottleneck either way. The strictly serial serving seen
  earlier under unified-off was memory pressure at 4 × 262144 slots (~115 GB), not the mode
  itself. At f16 three full 262144-token slots would need ~101 GB (86 GB of KV plus the weights) —
  the wedge zone — so the KV cache is stored at q8_0 instead (LM Studio's saved load config:
  `llm.load.llama.kCacheQuantizationType` / `vCacheQuantizationType` = q8_0 with flash attention on),
  which brings 3 × 262144 slots to ~62 GB wired with three streams still at 7.8–8.3 tok/s each.
  Current configuration for this setup: unified KV off, context-length 262144 (the model's maximum),
  parallel 3, q8_0 K/V cache, pi `contextWindow` 258000 (a margin under the slot for pi's output
  reserve), `maxConcurrent` 2 (+ the director's bypass = 3 clients ≤ 3 slots). Keep the model's
  saved default in LM Studio identical to the live load: a just-in-time load after an idle unload
  otherwise reverts to whatever the default says.
- **KV memory with dedicated slots**: unified-off KV buffers are allocated per slot — at ~110 KB
  per token (f16; q8_0 halves it), 4 × 262144-token slots cost ~100 GB of KV on top of the weights (~115 GB total),
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
`pi.ts` the pi subprocess integration, `git.ts` the git plumbing, `worktree.ts` the persistent
worktree lifecycle, `merge.ts` the
rebase/fast-forward/conflict-resolution landing flow), `src/ui/` the observer/presentation layer
(TUI, GUI dashboard, status table and transcript rendering — imported only by each other and
`cli.ts`), `test/` unit tests.
Tests fake pi with a shell shim on PATH, so they run offline.
