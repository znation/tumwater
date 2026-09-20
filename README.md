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
`status` (`--json`), `report` (`--days N`; Markdown usage report, default 14 days) and
`report --failures` (Markdown failure digest — tick outcomes, deltas, and clustered errors,
default 14 days), `doctor` (pre-flight check of node, git, repo, config, pi, locks, and build — read-only,
exits 0/1 so it can be scripted), `logs` (`-f`, `--role <id>`, `-n N`), `prompt "text"` /
`prompt --list` / `prompt --cancel <n>`, `reset-counters [--role <id>]`,
`wake [--role <id>]` (clears a backed-off fleet's sleep — the named roles, or all of them,
tick within one poll), `abort --role <id>` (kills one loop's in-flight tick; work discarded,
the loop keeps running), and `pause` / `resume` (operator-intent fleet gate: role loops stop
starting new ticks while in-flight ones finish; the director keeps running). All thirteen roles —
feature, bugfix, plan, readme, organize, coverage, clean, dry, perf, qa (~2 h clock), telemetry
(~2 h clock), improve, steward (~6 h clock) — plus the director are enabled by default; user-defined loops are added
from `customLoops` in tumwater.json or by prompting the director, and act as full-citizen loops
marked `*` on both dashboards. While main's build/test suite is red, code-producing roles skip
their authoring run and show a `main red` state in both dashboards until main is green again
(director, bugfix, and the markdown-only roles keep ticking — bugfix can land the fix); three
consecutive error ticks on one loop raise one `warning` and that loop reads `failing` in both
dashboards until a healthy tick. Queued landings show as `· land queue: N` in the status
header and both dashboard headers, and the landing role's row reads `landing <elapsed>`.
The daily cost budget has a third state: with `fallbackModel` naming a model pi prices at zero,
reaching `maxDailyCostUsd` switches every role loop to it (`budget_fallback`; header badge
`· fallback: <model> (cost n/a)`) instead of pausing them — the fleet degrades to free work
rather than stopping, and only a fallback that cannot be verified as free leaves it paused.

Open items:
- Planned: portability & packaging — run an installed copy on any repo/branch with any agent
  binary (planned 2026-09-14, requested by user; nine sub-plans in plans/portability.md, 4/7 split
  three ways on 2026-09-19).
- Planned: Repair traces — a required `Validation gap` line in BUGS.md Fixed entries (planned
  2026-09-17, requested by user).
- Planned: Show the exact prompt each run received — `tumwater logs --role <id> --prompt`
  (planned 2026-09-19).
- Open bugs: none.
- Open questions: none (this repo tracks no QUESTIONS.md; `init` seeds one for new projects).

Current main (`f52cac9`): build clean, suite 1179/1179.
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
   the same session to produce it; failing that the subject names the changed files), pins the
   sha by `refs/tumwater/landing/<role>`, and enqueues a landing in `.tumwater/land-queue/` —
   then the tick ENDS: it holds no slot through review, and the role's branch resets to main
   the moment its commit exists. The orchestrator drains the queue on a single serial landing
   slot that takes the same `maxConcurrent` permit as a role tick (at a higher-priority tier,
   so a queued landing jumps ahead of parked role waiters while authors keep ticking on the
   remaining slots) — an adversarial review gate over the full ahead-of-main
   diff, in a harness-owned worktree (`_land-<role>`) off the pinned ref: first a deterministic
   build pre-check (the project's declared verify script: `npm test` when declared, else
   typecheck/build; failure rejects without spending a model run), then a fresh-session
   reviewer against PRINCLES.md that replies `VERDICT: approve|reject` (md-only diffs are
   exempt); rejects reset the branch with reasons injected into the author's next tick,
   failures keep the commit for re-review under a 3-strike discard cap. When several landings are
   queued, the drain reviews each change individually but stacks the approved ones in one lander
   worktree, runs the declared check once over the combined tree, and fast-forwards main through
   the whole stack (`landBatchMax`, default 3, caps a batch); a red or un-assemblable stack falls
   back to one-at-a-time landings, each re-verified by its own gate. Approved work rebases
   onto main (so main's history stays linear), re-runs the declared check on the rebased tree
   when main moved under it, and fast-forwards under the merge lock — the only code that ever
   holds it, so other roles keep ticking behind an in-flight landing. A role with a queued or
   in-flight landing never starts a new tick, and `tumwater abort --role` reaches the landing
   itself (a deliberate stop discards the pin; a shutdown keeps it — every interrupted landing
   re-lands through the same gate on the next tick). The drain runs even while the fleet is
   paused: a queued landing is committed work, not a new tick. If pi found nothing to do, the
   loop backs off (exponentially, capped) and sleeps; an observer (`qa`) instead treats a
   `no_change` as a passing check and re-ticks at its interval, rotating through the documented
   flows via a gitignored coverage ledger and ending its tick with a `FLOW: <name> — passed|bug`
   line so its next tick can see what it last exercised. A failed tick retries on a
   shorter error ladder (capped at ten minutes) instead, so a broken toolchain parks a loop for
   minutes, not hours.
4. Sleeping loops wake early when main moves — the world changed, so the answer may have changed.

Scheduling is need-aware: a maintenance role's due tick (scheduled or main-moved) is deferred —
one `tick_deferred` event per episode in logs, TUI, and GUI — while its last tick did nothing
and no feature/bugfix/director/human commit has landed on main since; it starts within one poll
of such work landing. Observer roles (`qa`) are never deferred — an unmoved tree says nothing
about whether the running product has something new to report. While PLANS.md's Planned section
or BUGS.md's Open section is non-empty, idle maintenance ticks stay deferred regardless of
landings — queued feature/bugfix work outranks them until the backlog drains. Slot allocation
orders the work roles (feature, bugfix, plan) ahead of every maintenance role,
least-recently-ticked first within a tier — and the same tier order holds for ticks already
waiting on a slot across polls: a work-role tick that becomes due later jumps ahead of
maintenance ticks parked from an earlier poll (in-flight ticks always run to completion).

The fleet's autonomous spend is capped by `maxDailyCostUsd` (default $50; set 0 to disable).
While the day's total cost has reached the cap, role loops stop starting new ticks — scheduled,
main-moved wakes, or startup — until local midnight or a live edit raises/disables the cap;
in-flight ticks finish and the director stays exempt (its spend still counts toward the cap).
Name a free model as `fallbackModel` and they keep working instead of stopping: at the cap every
role loop switches to that model — author runs, reviewer, conflict resolution, and any per-role
model override alike — so the day's paid work ends but the fleet does not. Only a model pi's
`models.json` prices at zero is ever engaged (an unknown id, a priced model, or a missing
definitions file is refused, and the fleet pauses as it would without one), so spend cannot climb
past the cap either way. The operator-intent sibling is `tumwater pause` / `resume`: a persistent
marker that blocks new role ticks (same wake reasons, same director exemption) until lifted. Each
gate transition lands as one `budget_paused`/`budget_fallback`/`budget_resumed` or
`fleet_paused`/`fleet_resumed` event, visible in `tumwater logs`, the TUI activity pane, and the
GUI feed.

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
implementation run so the feature loop can land them whole — a plan too large for one run is
marked and handed to the plan loop to split, not split inline — and the reviewer works through a
five-point checklist and is told when the gate's deterministic pre-check already passed, so it
spends its run on what a green suite cannot show rather than re-running it.

Stopping the harness (Ctrl+C) mid-tick loses nothing: the interrupted loop's pi session and its
worktree's uncommitted edits stay in place, and on the next `tumwater run` that loop resumes the
same session (`--continue`) with a short bridge prompt and finishes the task it was on. A run the
quiet watchdog kills for lack of progress (tick result `quiet_killed`) is recovered the same way,
with the bridge prompt naming the hang instead of claiming a restart — but only up to 3
consecutive kills, after which the loop drops the starved session, raises one `warning`, reads
`failing` in both dashboards, and takes a fresh tick on the idle backoff ladder instead of
re-sending the session the backend could not schedule. A crash
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
starting new ticks while in-flight ones finish (role ticks up to the fleet's observed p75 tick
duration — a 30-minute cold-start fallback until enough ticks have completed — counted across the
whole hold even when main moves again meanwhile, after which they are aborted resuably; an in-flight
director tick is waited for without a cap — a human prompt outranks the redeploy), swaps the compiled tree into `dist/`, and exits so the `tumwater run` supervisor — the
process you started, which runs the orchestrator as a child — respawns it on the new code.
Completed auto-restarts are rate-limited to at most one per 12 h: inside that cooldown STALE
stays visible with a `restart BLOCKED: cooldown until …` deadline and ticks continue on the stale
build, so sustained churn cannot halt the fleet for a drain over and over. A green
verdict is reused fleet-wide; a red is provisional until two different worktrees have seen it,
because a suite can fail for reasons that belong to a worktree rather than to the tree. A red
main or a failed compile leaves the old build running until main moves again — a warning event,
and `restart BLOCKED:
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
tumwater report [--days N]   # Markdown usage report — tokens/ticks/commits per day (default 14 days; --days bounded to the GUI's shared 1–90 window)
tumwater report --failures [--days N]   # Markdown failure digest — tick outcomes, deltas, and clustered errors (default 14 days)
tumwater doctor       # pre-flight check: node, git, repo, config, pi, locks, build (read-only; exit 0/1)
tumwater logs -f      # follow harness events
tumwater logs --role feature   # that loop's pi transcript (also supports -f, -n N)
tumwater logs --role feature --prompt   # …and the exact prompt each run received
tumwater prompt "prefer no third-party deps"
tumwater prompt --list             # show queued prompts, numbered in execution order
tumwater prompt --cancel <n>       # remove the Nth queued prompt (as shown by --list)
tumwater reset-counters            # zero ticks/commits/tokens/cost (a running fleet picks it up within ~2s)
tumwater reset-counters --role feature   # …or just one loop
tumwater wake [--role feature]     # wake a backed-off fleet — the named roles (or all) tick within one poll
tumwater abort --role feature      # kill that loop's in-flight tick now (work discarded; the loop keeps running)
tumwater pause                     # stop role loops starting new ticks (in-flight finish; the director keeps running)
tumwater resume                    # lift a fleet pause
```

`reset-counters` starts a fresh observation window (e.g. "cost since today") without touching
scheduling, backoff, or pi session continuity — loops keep sleeping and waking exactly as before.
Its operator-side counterpart is `wake`: it touches ONLY the schedule (backoff cleared,
next run due now), so a fleet parked in backoff after a toolchain outage starts ticking
within one poll of the fix, instead of sleeping out its backoff.

Review-gate runs are labeled in loop transcripts: each role's raw log interleaves author ticks
and reviewer runs, and review runs render as `── review @ <timestamp> ──` in `tumwater logs
--role`, the TUI transcript pane, and the GUI detail panel.

`gui --all-interfaces` binds every network interface (IPv4 and IPv6) instead of localhost, and
prints the LAN URLs it is reachable at. The dashboard has **no authentication**, and its prompt
box feeds the director — anyone who can reach the port can steer the fleet and read every
transcript. Use it only on networks where that is acceptable.

Roles: `feature`, `bugfix`, `plan`, `readme`, `organize`, `coverage`, `clean`, `dry`, `perf`,
`qa`, `telemetry`, `improve`, `steward`, `director`. Enable/disable them, pick pi's provider/model/thinking
level, set a per-role tick interval (by default the steward runs on a ~6 h clock, qa and telemetry
on ~2 h, readme on 30 min and plan on 1 h — the bookkeeping roles batch a burst of landings into one sync
instead of restamping after every merge), and tune backoff in
`tumwater.json`. While the harness is running, edits to `tumwater.json` are picked up
within ~2s — every setting applies live: enabling/disabling roles, per-role provider/model/
thinking/instructions, tick intervals, backoff, the `maxConcurrent` cap and `landBatchMax` batch size, `autoRestart`, and
`sessionRetentionDays` (a mid-run edit re-prunes immediately). User-defined loops (`customLoops` entries in tumwater.json) can be added, removed, or rearranged by prompting the director ("add a loop named X that does Y") or by hand-editing the file (live within ~2 s); they act like any other loop and are marked with `*` beside their name on both dashboards.

Spend is capped by `maxDailyCostUsd` in tumwater.json (default 50; set 0 to disable): once the
day's total cost across all loops reaches it, role loops stop starting new ticks for the rest of
the local day — in-flight ticks finish and the director keeps running your prompts. The cap is
editable from both dashboards (TUI Ctrl+B on the prompt line; GUI header badge click-to-edit) —
they write tumwater.json like any other edit, so it applies live within ~2s.

`fallbackModel` (optional; `{ "provider": …, "model": …, "thinking": … }`, each field falling
back to the top-level value) names the free model the role loops switch to at the cap instead of
stopping — the budgeted model does the day's paid work, the free one keeps the fleet alive
afterwards:

```json
"provider": "huggingface", "model": "deepseek-ai/DeepSeek-V4.1-Flash",
"fallbackModel": { "provider": "omlx", "model": "Qwen3.8-27B-MLX-oQ4e-mtp" }
```

The switch covers every seam that could spend — author runs, the review gate, conflict
resolution, and any per-role `provider`/`model` override, which is dropped for the duration — and
only a pair pi's `models.json` prices at zero is accepted, so a typo or a priced model leaves the
fleet paused rather than quietly spending past the cap (the `budget_paused` event names the pair
it refused). The header badge reads `· budget: $10.02/$10 today · fallback: <model> (cost n/a)`
while the fallback is carrying the fleet, and the loops keep their ordinary state cells — they
are working, not stopped. The director never switches: an explicit human prompt outranks the
autonomous-spend cap. Everything is live, so crossing local midnight, raising the cap, or fixing
a mistyped fallback id takes effect within ~2s.

## Notes on local model servers

**Current setup, since 2026-09-18: a budgeted API primary with the local server as the cost n/a
fallback.** tumwater.json names `huggingface` / `deepseek-ai/DeepSeek-V4.1-Flash` (HF Inference
Providers' OpenAI-compatible router at `https://router.huggingface.co/v1`) with
`maxDailyCostUsd` 10, and `fallbackModel` `omlx` / `Qwen3.8-27B-MLX-oQ4e-mtp` — so the fleet
spends up to $10/day on the API model and then keeps working locally for free until local
midnight. pi 0.84.2 ships a built-in `huggingface` provider whose catalog predates V4.1-Flash, so
`~/.pi/agent/models.json` adds just that model (declared at $0.30/$1.20 per million tokens — the
highest rate among the providers the router auto-selects as of 2026-09-18, so the cap trips no
later than real spend) and inherits the provider's base URL and env-based key. **The key is the
one thing not in any config file: export `HF_TOKEN` in the environment that runs `tumwater run`**
(`pi auth check --provider huggingface --json` reports `ready` once it is set). The two models'
context windows differ by an order of magnitude (1,048,576 vs 126,928); ticks start a fresh pi
session with a small prefill, so a switch mid-day is safe, but a role prompt written for the API
model's window would not be.

**Local backend: oMLX (MLX), since 2026-09-14.** `/Applications/oMLX.app` 0.7.0.dev2 serves
`fcmeyer/Qwen3.8-27B-MLX-oQ4e-mtp` (API id `Qwen3.8-27B-MLX-oQ4e-mtp`) at `127.0.0.1:8000` — an
imatrix-calibrated ~4.9 bpw quant that preserves the model's native MTP head, so oMLX runs
Lightning MTP speculative decoding (2.5–3.0 tokens per backbone cycle at 68–84% draft acceptance;
the `lmstudio-community` checkpoints carry no MTP tensors, making `mtp_enabled` a no-op there).
oMLX config lives outside this repo in `~/.omlx/`: `model_settings.json` sets
`max_context_window` **131072**, pinned + default;
`settings.json` sets `max_concurrent_requests` **3**, `memory_guard_tier` aggressive,
`hot_cache_max_size` 4GB and an API key. pi (`~/.pi/agent/`) and omp
(`~/.omp/agent/models.yml` — YAML, not models.json) both use provider `omlx`,
`api: openai-completions`, `contextWindow` **126928** (a 4144-token margin under the server's
limit for pi's output reserve), and must send the API key. `tumwater.json`
names `provider`/`model` explicitly so `fleetModelsFree()` sees a free fleet, with
`maxConcurrent` **3** — the three role loops alone saturate all three slots (at 2, one slot
sat idle whenever the director was not running, which is most of the time), and the
director's bypass makes a fourth client only while it is active (~10–15% of ticks); the
fourth request queues rather than joins the batch (`max_num_seqs` stays 3), so MTP draft
acceptance is untouched, and its measured 103–118 s TTFT sits well inside pi's 30-min idle
timeout and the harness's quiet watchdog. Measured server-reported:
**35.2 tok/s per stream at ~51k context** (fleet paused); a slot sweep at ~20k context put 3 slots
ahead of 4 on every axis — 73.3 aggregate / 24.4 per stream / 74.2% draft acceptance / 28.3 GiB
peak wired, versus 65.0 / 16.2 / 69.7% / 32.6 GiB — because MTP acceptance falls monotonically with
concurrency (unaligned batches drop back to standard decode). Rate is strongly context-dependent,
so quote a context size with any tok/s figure.

Do not reach for the slot count to fix memory pressure: it was tried twice (6→4, then 4→3) and
moved nothing either time. At 3 slots the live footprint was pool ~57 GB / KV 10.8 GB / hot cache 0
/ model 16 GB — the pinned MLX buffer pool is ~60% of it and does not scale with concurrency.

A third deliberate value: `max_context_window` is **131072, not the model's 262144 maximum**. At the
full window oMLX aborted prefills outright — `Request aborted: process memory limit exceeded (usage
111.0 GB, abort threshold (hard watermark) 92.1 GB, metal_cap ceiling 96.9 GB)` — killing 9 ticks,
three at a time, because `_get_dynamic_ceiling` is recomputed every poll and collapses when the rest
of the Mac is busy, taking the abort threshold down with it. Halving the window halves the
worst-case prefill transient and KV. Live ticks peak around 64-80k, so 131072 still leaves ~1.6x
headroom. The companion fix is `memory_guard_tier: aggressive` (active-reclaim ratio 0.5 -> 0.8),
which holds the ceiling at the Metal cap instead of letting it collapse, plus `hot_cache_max_size`
4GB. **Slot count is not a lever here** — it was tried twice (6->4, 4->3) and moved nothing; the
pinned MLX pool is ~60% of the footprint and does not scale with concurrency.

Two oMLX settings are deliberately left at non-obvious values:
- `chunked_prefill` stays **false** (its default). Turning it on collapsed throughput ~20× here
  (16.4 → 0.8 tok/s, TTFT 118 s): the fleet's large prefills interleave continuously and starve
  decode.
- `prefill_memory_guard` is **on** (re-enabled 2026-09-14 with the 16 GB oQ4e model). It had been
  turned off under the earlier 8-bit model, where oMLX's pinned buffer pool
  (`mx.set_cache_limit(total_mem)`, issue #300 — otherwise `allocator::free()` can release a Metal
  buffer the GPU still holds and panic on M4) made the enforcer read the pinned pool as pressure:
  562 trips in 46 min, each forcing a synchronized `clear_cache()` that stalled every stream — a
  visible sawtooth in tok/s — while wired memory oscillated ~40 ↔ 107 GiB. With the 16 GB model the
  peak wired across the whole slot sweep was 49.7 GiB against the 96.8 GiB soft watermark, and the
  guard has logged 0 pressure trips in 30 min — the OOM safety net is back with no stalls.

The bullets below were written for the previous **LM Studio / GGUF** backend and are kept as
hard-won background; the llama.cpp-specific parts (unified KV, slot allocation, q8_0 flags) no
longer describe what runs.


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
  Historical LM Studio configuration (superseded by oMLX, above): unified KV off, context-length 262144 (the model's maximum),
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
npm test               # build + full unit suite (node:test)
npm test <filter>      # …or just the test files whose name contains <filter> (e.g. npm test merge)
```

Layout: `src/` harness code (`loop.ts` is the tick lifecycle, `orchestrator.ts` the scheduler,
`pi.ts` the pi subprocess integration, `git.ts` the git plumbing, `worktree.ts` the persistent
worktree lifecycle, `merge.ts` the
rebase/fast-forward/conflict-resolution landing flow), `src/ui/` the observer/presentation layer
(TUI, GUI dashboard, status table, transcript, and report rendering — imported only by each other
and `cli.ts`), `test/` unit tests.
Tests fake pi with a shell shim on PATH, so they run offline.
