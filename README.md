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
v0.1: working harness. `init`, `run`, `tui`, `gui`, `status`, `logs`, and `prompt` commands are
implemented with twelve roles plus the director loop (absolute scheduling priority; routes
feature/bug requests into PLANS.md/BUGS.md, decomposing independent subparts). Every tick runs
in a fresh pi session — context never accumulates across ticks, and durable knowledge lives in
the repo (README/PLANS/BUGS/QUESTIONS), which each tick reads first; a tick interrupted by Ctrl+C or a
crash is resumed on the next launch (same pi session, worktree edits kept), and a tick cut off at
the context ceiling resumes its just-compacted session instead of idling; merge conflicts get
one pi-driven resolution attempt; roles can override provider/model/thinking; `tumwater.json` is
validated on load/save with actionable errors; logs rotate and old pi sessions are pruned; the
TUI/status table is width-aware with a totals row; transient sleep/wake "predict stream timed
out" failures are retried once without dropping healthy sessions. Per-loop pi transcripts are
observable three ways: `tumwater logs --role <id>` (run separators, abbreviated thinking,
assistant text, tool calls; `-f` follows live), the TUI's activity pane (Ctrl+T cycles recent
events → each loop's transcript → project status, all in place), and a click-to-toggle panel in the GUI
(`/api/transcript?role=&n=`). The quiet watchdog measures progress, not bytes — structural
events or real content growth keep a run alive, so zombie streams dripping empty keepalives are
killed instead of resetting it. Queued director prompts are re-queued if their tick fails without
landing work. Work lands on main via rebase, keeping commit history linear; `tumwater.json` reloads live while
running (roles, per-role provider/model/thinking/instructions, tick intervals, backoff — only
`maxConcurrent`/`sessionRetentionDays` need a restart). BUGS.md has no open bugs. The latest entry — feature tick 52 broke main's build: its questions-outbox changes made `StatusSnapshot.questions` required and gave `backlogLines` a third argument without updating test/status-render.test.ts, test/tui.test.ts, or (invisibly to tsc) test/init.test.ts's committed-file list (five type errors; the sixth broken landing, through the same reviewer-cannot-compile hole the review-gate plan's pending build pre-check closes) — is fixed and recorded under BUGS.md's Fixed section, as are the earlier main build breaks (feature ticks 47 and 49). `tumwater reset-counters` zeroes ticks/commits/tokens/cost without a
restart (a running fleet picks it up within ~2s); the GUI/TUI tables show each working loop's
current work item; both dashboards show project status — planned features, open bugs, and open questions from
PLANS.md/BUGS.md/QUESTIONS.md (TUI's Ctrl+T cycle, a GUI panel), with a `questions: N` header badge while any await. The QA role has landed (feature tick 53): a never-edits-source role that acts as a first-time user — each
tick follows one README usage flow, cheapest-first, in a scratch dir under the system temp, checks outputs
against what the docs promise, and files reproducible bugs in BUGS.md (its only write; md-only diffs stay
review-exempt), on a ~2 h clock by default. Against its plan what remains is dogfood observation only — a
planted doc/behavior mismatch discovered within a few qa ticks, and no orphaned processes after its ticks.
The QUESTIONS.md outbox has landed in code (feature tick 52): `init` seeds a tracked QUESTIONS.md, every prompt reads it first and carries the ask-don't-guess rule, the director routes "answer Qn" prompts to ## Answered, and both dashboards surface open questions. The plan loop audited it on 2026-08-28: what remains is the `question_posted` event emission in tryMerge (the type and rendering exist; nothing emits it yet) and the planned test suite. The refusal sentinel with friction signals has landed in code
(feature tick 51): a `TUMWATER_REFUSED: <reason>` reply declines work that would harm the project,
committing only its markdown objection note under the refused entry's heading in PLANS.md/BUGS.md —
which blocks the entry until a human or the director clears it, since every role skips entries
carrying a Refused note — and discarding any non-markdown half-work; changed ticks burning more than
`thrashTurns` turns (default 40) or `thrashMinutes` minutes (default 60) are flagged high-friction,
with a warning event plus extra review scrutiny, since difficulty is a signal the work may not fit.
The plan loop audited it on 2026-08-28 (verified at `8ea49b8`, suite green): what remains is three items — the planned test suite has only its sentinel-parse half (test/refusal.test.ts
landed via a coverage tick; loop e2e, thrash-flag, and prompt-contract tests are still missing), AC3's high-friction trailer line was never implemented (`commitTrailer` takes no friction argument, so a flagged tick carries no marker in git history), and AC5's config validation for `thrashTurns`/`thrashMinutes` is untested. The slow-clock steward has
landed in code (feature tick 49): a markdown-only curation role on a ~6 h per-role clock (the new
`minTickIntervalSeconds` override of the global interval), enabled by default; its landing commit's
build break is fixed (BUGS.md). The plan loop audited it on 2026-08-28 (verified at `ceb6019`, suite green): what remains is test gaps — no role-prompt contract tests, and the per-role interval untested at scheduler level — plus dogfood pending (no `tumwater(steward)` commit in history yet). Self-explaining commit bodies has landed in code (feature
tick 48): every commit now carries the author's WHY/RISK/VERIFIED body plus a harness-stamped
trailer (`Tick: <role> #<tick> · turns N · ctx M`), and the reviewer checks the claimed WHY/VERIFIED
against the diff; the plan loop audited it on 2026-08-28 (verified at b101c02, suite green) — what
remains is two test gaps against its acceptance criteria (a tick-level e2e that a compliant reply
produces a commit carrying body + trailer, and turn-counter coverage), nothing structural. The review gate has landed end-to-end (feature tick 47): every
non-exempt commit now passes a fresh-session reviewer over the full ahead-of-main diff against
PRINCIPLES.md before rebase/merge — `VERDICT:` parsing, md-only exemption (`*.md`/`docs/**`),
fail-closed 3-strike discard; a rejection resets the branch and injects its reasons into the
author's next tick (scheduled like a change, no backoff); a failed review keeps the commit on the
branch for recovery re-review, which routes through the same gate. Review events render in
`tumwater logs`, dashboards show `reviewing <elapsed>` while a loop is under review, and
test/review.test.ts covers the pure functions plus gate orchestration end-to-end; the plan loop
re-audited it on 2026-08-28 and verified every item landed — the reject→next-prompt
injection gap closed with a loop test (coverage tick `8ea49b8`); what remains is two test gaps against
the acceptance criteria (merge lock not held during review, `reviewing <elapsed>` state cell) plus one small code item from the plan's 2026-08-28 refinement: a
deterministic build pre-check in which the harness itself runs the project's npm typecheck/build
script as the gate's first step (after the md-only exemption, before any reviewer run; failure
rejects with the compiler tail as reasons), closing the hole that let tick 49's type error land. The last-tick
timestamp plan has landed: both dashboards show each loop's last tick end as an absolute local
time alongside its relative age. The report's PRINCIPLES.md plan has landed: every tick prompt now carries the
project's tracked PRINCIPLES.md (documented under How it works).
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
   diff — a fresh-session reviewer against PRINCIPLES.md that replies `VERDICT: approve|reject`
   (md-only diffs are exempt); rejects reset the branch with reasons injected into the author's
   next tick, failures keep the commit for re-review under a 3-strike discard cap. Approved work
   rebases the branch onto main (so main's history stays linear) and fast-forwards — all under a
   merge lock shared by every loop. If pi found nothing to do, the loop backs off (exponentially,
   capped) and sleeps.
4. Sleeping loops wake early when main moves — the world changed, so the answer may have changed.

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
tumwater reset-counters            # zero ticks/commits/tokens/cost (a running fleet picks it up within ~2s)
tumwater reset-counters --role feature   # …or just one loop
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
within ~2s — enabling/disabling roles, per-role provider/model/thinking/instructions, tick
intervals, and backoff all apply live; only `maxConcurrent` and `sessionRetentionDays` require a
restart.

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
  *progress* — structural events or actual content growth — happens, so content-free keepalives
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
`pi.ts` the pi subprocess integration, `git.ts` the worktree/merge machinery), `test/` unit tests.
Tests fake pi with a shell shim on PATH, so they run offline.
