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
landing work. Work lands on main via rebase, keeping commit history linear; `tumwater.json` reloads live while running — every setting applies without a restart (roles,
per-role provider/model/thinking/instructions, tick intervals, backoff, the `maxConcurrent` cap, and
`sessionRetentionDays`, whose mid-run edits re-prune immediately). BUGS.md carries no open bugs; its Fixed section records clean tick 91's broken GUI-page assertion (repaired by coverage tick `91a0843`) and the earlier main build breaks — including organize tick 78 (`369a085`), which deleted git.ts's rebase/fast-forward/conflict helpers without landing their move into merge.ts, fixed by bugfix tick 74 (`2cff978`) completing that intended move. The latest entry there — feature tick 52 broke main's build: its questions-outbox changes made `StatusSnapshot.questions` required and gave `backlogLines` a third argument without updating test/status-render.test.ts, test/tui.test.ts, or (invisibly to tsc) test/init.test.ts's committed-file list (five type errors; the sixth broken landing, through the reviewer-cannot-compile hole now closed by the deterministic build pre-check) — is fixed and recorded under BUGS.md's Fixed section, as are the earlier main build breaks (feature ticks 47 and 49). `tumwater reset-counters` zeroes ticks/commits/tokens/cost without a
restart (a running fleet picks it up within ~2s); the GUI/TUI tables show each working loop's
current work item; both dashboards show project status — planned features, open bugs, and open questions from
PLANS.md/BUGS.md/QUESTIONS.md (TUI's Ctrl+T cycle, a GUI panel), with a `questions: N` header badge while any await. The QA role has landed (feature tick 53): a never-edits-source role that acts as a first-time user — each
tick follows one README usage flow, cheapest-first, in a scratch dir under the system temp, checks outputs
against what the docs promise, and files reproducible bugs in BUGS.md (its only write; md-only diffs stay
review-exempt), on a ~2 h clock by default. Against its plan what remains is dogfood observation only — a
planted doc/behavior mismatch discovered within a few qa ticks, and no orphaned processes after its ticks.
The QUESTIONS.md outbox has landed end-to-end (feature tick 52; plan moved to Done in PLANS.md): `init` seeds a tracked QUESTIONS.md, every prompt reads it first and carries the ask-don't-guess rule, the director routes "answer Qn" prompts to ## Answered, both dashboards surface open questions, and tryMerge (src/merge.ts) emits one `question_posted` per new Open heading alongside the `merged` event. The plan loop's final audit on 2026-08-29 verified every acceptance criterion met or tested — feature tick 58 (`1a48edc`) landed the emission, its loop e2e with a negative control, the whitespace-collapsed prompt-contract assertions, and the `· questions: N` header-badge test; coverage tick `931ca26` closed the last item with the TUI nudge-line test (in test/tui.test.ts; it originally landed as test/tui-run.test.ts, since merged) — verified at `15657bd`, suite 423/423. The refusal sentinel with friction signals has landed in code
(feature tick 51): a `TUMWATER_REFUSED: <reason>` reply declines work that would harm the project,
committing only its markdown objection note under the refused entry's heading in PLANS.md/BUGS.md —
which blocks the entry until a human or the director clears it, since every role skips entries
carrying a Refused note — and discarding any non-markdown half-work; changed ticks burning more than
`thrashTurns` turns (default 40) or `thrashMinutes` minutes (default 60) are flagged high-friction,
with a warning event plus extra review scrutiny, since difficulty is a signal the work may not fit.
The plan loop re-audited it on 2026-08-29: the planned test suite has since landed its refusal-path
git-helper units (test/git.test.ts, which also fixed a UTF-8 mojibake bug in C-quoted porcelain path
decoding) and its loop e2e half (coverage tick `bc479b6`: md-only + mixed refusal lands only the note
with code changes discarded and skips review; no-note refusal resets clean). Feature tick 57
(`c477ce9`) then landed three of the four remaining items — AC3's high-friction trailer line (the
decided sibling `Friction: high (<turns> turns / <minutes>m)` git-trailer after the Tick line,
carried only by changed ticks), the prompt-contract assertions, and AC5's config validation for
`thrashTurns`/`thrashMinutes`; its contract tests first broke on prompt line-wrapping (recorded in
BUGS.md's Fixed section) until an improve tick made them reflow-robust. Feature tick 59
(`7212a7e`) then landed that last item — the thrash-flag loop tests in test/loop.test.ts, one per
threshold plus a negative control, with the turns-threshold e2e asserting the `Friction:` trailer
line in the commit's git log; every acceptance criterion of plans/refusal-and-thrash.md has now
landed (verified at `da79bcd`, suite 435/435); its last residual test — no-note refusal's
tick_end event — then landed (`8e6eeae`), and the plan is moved to Done in PLANS.md. The slow-clock steward has
landed in code (feature tick 49): a markdown-only curation role on a ~6 h per-role clock (the new
`minTickIntervalSeconds` override of the global interval), enabled by default; its landing commit's
build break is fixed (BUGS.md). The plan loop audited it on 2026-08-28 (`ceb6019`, suite green) and re-audited it twice more as its test gaps closed one by one — coverage tick `be6dc56` landed the isEligible min-gap honoring a per-role override at scheduler level (test/orchestrator.test.ts), and feature tick 68 (`bf42c98`) then closed all three remaining items: the steward prompt contract tests as a sibling block in test/prompt.test.ts (where organize tick `c3779b8` had moved the qa role's contract tests when it merged qa-role.test.ts into the module-named files), an e2e that a changed tick schedules its next run at the role's own interval through a real tick (test/loop.test.ts), and validation rejecting a negative per-role `minTickIntervalSeconds` (test/config.test.ts) — leaving only dogfood pending (no `tumwater(steward)` commit in history yet). Self-explaining commit bodies has landed in code (feature
tick 48): every commit now carries the author's WHY/RISK/VERIFIED body plus a harness-stamped
trailer (`Tick: <role> #<tick> · turns N · ctx M`), and the reviewer checks the claimed WHY/VERIFIED
against the diff; the plan loop audited it on 2026-08-28 (verified at b101c02, suite green). Its first test gap has since closed — coverage tick `d930959` landed the tick-level e2e in test/loop.test.ts: a compliant fake-pi reply produces a real commit on main carrying subject + WHY/RISK/VERIFIED body (contract order) + trailer, read from actual `git log`, and a SUMMARY-only reply commits subject + trailer only with no body paragraph; feature tick 67 (`4021c1d`) then closed that last gap — parser-level `parser.turns` assertions in test/pi.test.ts (including the zero-turn case), a changed-tick e2e whose trailer sums both runs' turns across a transient retry, and an extended conflict-resolution e2e proving resolution runs stay out of the count — moving the plan to Done in PLANS.md. The review gate has landed end-to-end (feature tick 47): every
non-exempt commit now passes a fresh-session reviewer over the full ahead-of-main diff against
PRINCIPLES.md before rebase/merge — `VERDICT:` parsing, md-only exemption (`*.md`/`docs/**`),
fail-closed 3-strike discard; a rejection resets the branch and injects its reasons into the
author's next tick (scheduled like a change, no backoff); a failed review keeps the commit on the
branch for recovery re-review, which routes through the same gate. Review events render in
`tumwater logs`, dashboards show `reviewing <elapsed>` while a loop is under review, and
test/review.test.ts covers the pure functions plus gate orchestration end-to-end; the plan loop
re-audited it on 2026-08-28 and verified every item landed — the reject→next-prompt
injection gap closed with a loop test (coverage tick `8ea49b8`). The plan's last code item has since landed — the deterministic build pre-check (feature tick 54, `93d14f5`; tests via bugfix tick 58, `038519a`): the harness itself runs the project's npm typecheck/build script as the gate's first step, after the md-only exemption and before any reviewer run; detection walks up from the worktree to the nearest package.json + node_modules (worktrees carry no install of their own), preferring `typecheck` over `build`; a failed build rejects deterministically with the compiler tail as reasons (no pi run consumed), while a timeout or missing npm warns and proceeds to model review rather than failing closed — closing the hole that let tick 49's type error land. The plan loop re-audited it on 2026-08-29 (verified at `d789962`, suite green) and feature tick 56 (`50ef9eb`) then closed the remainder — pre-check units in test/review.test.ts (detectBuildCheck edge cases, runBuildCheck's no-npm branch, clipBuildTail), gate e2e (a failing build rejects deterministically with zero reviewer runs; a hanging script warns and proceeds to model review), plus the two older items: merge lock not held during review (two concurrent fake-pi loops) and the `reviewing <elapsed>` state cell — moving the plan to Done in PLANS.md; its new tests also found that clipBuildTail must drop npm's own script banner lines so a quiet failure names what broke, not the script. The last-tick
timestamp plan has landed: both dashboards show each loop's last tick end as an absolute local
time alongside its relative age. The report's PRINCIPLES.md plan has landed: every tick prompt now carries the
project's tracked PRINCIPLES.md (documented under How it works). A bugfix loop found and fixed one more scheduling gap (`f773a49`, recorded under BUGS.md's Fixed section): an interrupted tick on a slow-clock role (steward ~6 h, qa ~2 h) was held by the per-role min interval for up to a full clock before its resume ran — `isEligible` now checks the pending resume before the min gap, so an aborted or crashed tick resumes promptly on restart while cut-off resumes still wait one interval as designed. The daily cost budget has landed in code (feature tick 62, `041fd55`; plan audited 2026-08-30): the top-level `maxDailyCostUsd` caps the fleet's autonomous spend — enabled by default ($50/day; 0 disables) — with a per-loop local-day window in LoopState that rolls over at midnight on write and reads $0 for a stale or missing stamp, so old state files load unchanged. While the day's fleet spend has reached the cap (the director's spend counts toward it), the orchestrator skips role ticks before eligibility — no scheduled tick, main-moved wake, or startup tick starts; in-flight ticks finish; and the director stays exempt, since an explicit human prompt outranks the autonomous-spend cap. Resume is live and stateless: raising/disabling the cap or crossing midnight flips the pure `budgetPaused` predicate on the next ~2 s poll via the existing config reload; one `budget_paused`/`budget_resumed` harness event per transition renders in logs/TUI/GUI, both dashboards show a `· budget: $12.34/$50 today` header badge while enabled, and paused role loops' state cell reads `budget paused`. `reset-counters` deliberately does not zero the daily window — the budget is a safety valve, not an observation window. Coverage tick `01c28ce` landed the gate e2e (a tiny cap blocks the second role tick while a queued director prompt still runs; a live cap raise resumes within one poll) and status-render units cover the badge and state cell. The plan loop re-audited it on 2026-08-30 (`bb77554`): every code clause verified landed, with six remainders — five test work plus one README edit, all pickable independently: (a) state-helper units in test/state.test.ts, (b) config units in test/config.test.ts, (c) event-rendering units in test/event-format.test.ts, (d) GUI-surface units in test/gui.test.ts, (e) two untested AC3 clauses in test/orchestrator.test.ts (startup at cap starts no role ticks; a main-moved wake while paused stays blocked), and (f) the README clause documenting `maxDailyCostUsd` in Usage/How-it-works. Item (a) has since landed (coverage tick `07d5bf6`: recordDailyCost's same-day accumulation and midnight rollover on write, dailyCost's stale/missing → $0 non-mutating reads, fleetDailyCost summing with stale loops at $0, budgetPaused at cap 0 / below / at-or-above, plus the zeroCounters-preservation and loadLoopState missing-fields assertions), and item (b) has landed too (coverage tick `2fbfb49`: defaultConfig carries 50; negative/non-numeric values rejected with actionable errors; a typo'd key fails via TOP_LEVEL_KEYS' unknown-key error; loadConfig over an existing file lacking the key picks up the default without editing). Coverage tick `92a4ffe` then landed one more unit beyond the six — snapshot()'s budget wiring in test/status.test.ts (today's spend summed from persisted loop state, stale stamps reading $0; cap 0 drops the badge data). Feature tick 65 (`b589e09`) closed items (c)–(e): event-rendering units for both transition events (plain lines carrying spend and cap, no warning prefix), three GUI-surface units (/api/status's `budget` payload while enabled vs null when disabled, the served page's header badge derived from it, a paused fleet's idle role loops reading `budget paused` with the director exempt), and both AC3 orchestrator clauses (startup at cap starts no role ticks; a main-moved wake while paused stays blocked) — re-verified at `b589e09`, build clean, suite 468/468. Item (f) has since landed — feature tick `6e3ac7a` documented `maxDailyCostUsd` in Usage and How-it-works, moving the daily cost budget plan to Done in PLANS.md with nothing remaining. Since then, plan tick `c745f4c` added two sibling plans — live `maxConcurrent` and live `sessionRetentionDays`, which together would make every tumwater.json edit apply live (the last two restart-only settings) — and organize tick 78 (`369a085`) broke main's build; bugfix tick 74 (`2cff978`) fixed it by landing the intended move of the six landing-flow helpers into src/merge.ts (with a runtime regression test pinning their new home), dry tick `f964c2f` extracted shared local date/time formatters into text.ts, and coverage tick `05f7a13` added pidAlive unit tests. Since then, plan tick `b9abcaa` refined the live maxConcurrent entry: its original release() spec (hand the freed permit straight to the next queued waiter) contradicted the shrink goal and would have pinned concurrency above a shrunken cap; corrected to always decrement in-use first, then admit waiters while under the cap, with an explicit unit AC pinning that path. Clean tick `fa2a7db` dropped readCompleteLines' phantom trailing empty string from its split (src/tail.ts), and perf tick 60 (`b64b11a`) gave the transcript renderer a type-prefix fast path that skips JSON.parse for pi's ~97% streaming-delta lines (~28–46 ms → ~5–8 ms per 12–21 MB log re-read; any line not matching the compact `type`-first shape falls through to a full parse, so no output can be lost). Feature tick 70 (`af61b7e`) then landed live maxConcurrent: the Semaphore now tracks capacity and in-use separately (a free-permit count cannot represent a shrink below current in-use) with setCapacity(n) — growing admits queued waiters up to the new headroom, shrinking never preempts in-flight work but caps future grants until releases drain under the cap; the orchestrator's reload block applies it within one ~2 s poll and logs exactly one `max_concurrent_changed` harness event per distinct value change (a plain line in logs/TUI/GUI); test/semaphore.test.ts covers grow/shrink/FIFO/no-leak units, and test/orchestrator.test.ts an e2e with a concurrency-recording fake-pi shim (peak stays 1 at cap 1; a live edit to 2 overlaps runs without a restart; shrinking back admits no new concurrent run until in-flight work finishes). Organize tick `a5dd4bf` extracted refusal handling from loop.ts into src/refusal.ts (with test/refusal.test.ts), coverage tick `61e5495` added the formatEvent unit for question_posted rendering, and improve tick `510c098` made display clipping surrogate-pair-safe: text.ts's truncate and status-render's clipToWidth back off one code unit when a cut would split an astral pair (a lone high surrogate renders as a U+FFFD box in terminals), and the director inbox's prompt_enqueued preview now goes through truncate instead of a raw slice — units for each. Plan tick `9edc097` then audited the live maxConcurrent plan against its acceptance criteria — every clause met or tested, with one recorded deviation (the e2e uses three fast-ticking roles over one slot so a queued tick exists for the grow to wake) — and moved it to Done in PLANS.md. Since then: coverage tick `e3f1cbd` added files.ts units for cachedByStat's vanish/fail-load/eviction branches; plan tick `5ff753e` refined the live sessionRetentionDays plan against main (`dd01cf6`) with four spec-gap corrections — pinning the e2e's planted-file ages, initializing both trackers at startup regardless of whether startup pruning ran, decoupling the once-per-day prune gate from reload success (it polls the same last-known-good config as the budget gate), and adding a `retention_changed` event per distinct value change so live edits are visible even when nothing is pruned — leaving it the only Planned entry awaiting implementation (steward's remainder is dogfood observation only) and the last restart-only setting; organize tick `1c9bb8d` extracted the no-change diagnosis from loop.ts into src/no-change.ts (`diagnoseNoChange` classifies a sentinel-less run as cut-off-at-ceiling vs non-compliant, with its own test file). Since then: coverage tick `f7eff6a` added two tests to test/git.test.ts — changedFiles decoding C-quoted carriage returns in filenames (the decoded path feeds straight back to `git add`, so a misdecode stages nothing) and unquotePorcelainPath's defensive branches for malformed or unrecognized escapes degrading to keep-as-is; clean tick `a23059c` moved pi.ts's two error regexes above their use site in feedLine; dry tick `f157685` factored the `$<spent> of $<cap>` fragment shared by both budget transition events into a budgetPhrase helper in event-format.ts. Since then: feature tick 73 (`eaa9848`) landed the live sessionRetentionDays core in src/orchestrator.ts — an exported `dueForPrune` pure helper (due when retention > 0 and a full day has passed since the last prune) plus poll-cycle bookkeeping that re-prunes immediately on a mid-run edit to the window, prunes an unchanged fleet at most once per day, and reads the same last-known-good config as the budget gate — so `sessionRetentionDays` now applies live in behavior; its plan's remainders are the `retention_changed` event, the e2e/unit tests, and the Usage handoff sentence. Plan tick `cb41f9c` then added two sibling plans for the director inbox: CLI management (`tumwater prompt --list` / `--cancel <n>` over a shared `queuedPrompts` reader, with one `prompt_cancelled` event per removal) and dashboard display of queued prompts in TUI/GUI (cancellation stays CLI-only). Since then: coverage tick `377ad2c` added the CLI test for the TUI readiness gate and its no-TTY error path (test/cli.test.ts); feature tick 74 (`53c0477`) landed that inbox CLI management — `tumwater prompt --list` prints the queued prompts numbered in execution order ("nothing queued" when empty) and `--cancel <n>` removes the Nth, confirming with its 80-char preview (a concurrent dequeue by the director is reported as "no longer queued", not an error), both over the shared `queuedPrompts(root)` reader in src/inbox.ts; each removal logs one plain-line `prompt_cancelled` event (`user prompt cancelled: <preview>`); and the `prompt` command now parses real flags following init's pattern, so an unknown double-dash flag fails instead of being baked into the queued text (closing a latent hole where `tumwater prompt --foo text` would have enqueued "--foo text"); units in test/inbox.test.ts plus event-rendering units; readme sync `349482e` also added the plan's Usage lines, leaving only the CLI-level tests in test/cli.test.ts as its remainder (re-audited below). Plan tick `3104171` then re-audited the live sessionRetentionDays entry against main: the core is verified landed (feature tick 73), two deviations from its pins recorded rather than forced (`dueForPrune` takes a nullable last-prune stamp with an explicit never-pruned → due-immediately branch; `lastPruneAt` initializes to null when startup retention is 0 — behavior identical for every edit sequence), and the remainder re-specified as four independently pickable items: (a) the `retention_changed` event per distinct value change, (b) `dueForPrune` units, (c) the live-edit e2e asserting that event (lands after a), and (d) this README handoff — since done by readme sync `349482e`, which rewrote Usage's live-reload sentence to name `sessionRetentionDays` among the settings that apply live (a mid-run edit re-prunes immediately); its remainders are now (a)–(c). Since then: dry tick `4c96753` factored the in-flight tick label duplicated between workingDetail and loopPhase's review branch into an `inFlightLabel` helper in src/status-render.ts ("working 3m", "reviewing 2m"), so their elapsed formatting cannot drift; plan tick `1d5ac65` then re-audited the director-inbox CLI plan against main — core verified landed (feature tick 74), Usage lines in readme sync `349482e` — leaving a single remainder: the spec'd CLI-level tests in test/cli.test.ts (--list's empty and numbered full-text cases; --cancel removing exactly the Nth with siblings renumbered; out-of-range/missing/non-positive failures leaving the queue untouched; argument-shape failures including the `--foo`-baked-as-content regression). Coverage tick `9c20312` then landed that last remainder — the CLI-level tests in test/cli.test.ts exactly as spec'd (--list's empty and numbered full-text cases; --cancel removing exactly the Nth with siblings renumbered; out-of-range/missing/non-positive failures leaving the queue untouched; argument-shape failures including the `--foo`-baked-as-content regression) — closing every item of the director-inbox CLI plan, which now awaits its move to Done in PLANS.md. Clean tick 91 (`66e94a4`) gave the GUI's budget badge a `fmtUsdCap` helper so whole-dollar caps read bare ($50, not $50.00) like the TUI's usdCap — both dashboards now read identically for one config; but its accompanying test assertion is broken (its regex expects the string form `.replace("/\.00$/", "")` where gui-page.ts has a regex literal), leaving main's suite red at 530/531 — recorded in BUGS.md's Open section; the served page itself is verified correct (fmtUsdCap(50) → `50`). Feature tick `55af189` then landed queued-prompt display on both dashboards: `StatusSnapshot.inboxPrompts` carries execution-order previews truncated to 80 chars, read fresh per poll alongside the inbox count; the TUI renders one numbered line per prompt between the table and the activity pane (each consuming exactly one line of eventBudget, like the questions nudge), `/api/status` carries them, and the GUI's project status panel lists them via its backlogList helper with `(none)` while empty — moving that plan to Done in PLANS.md. Perf tick `fbefd9e` gave live progress seeding (src/progress.ts) the same type-prefix fast path as transcript.ts's renderer: pi log lines whose compact `type`-first shape is verifiably not one of feedLine's three acted-on types (session, tool_execution_start, message_end) skip JSON.parse entirely (~7 ms → ~1 ms per 4 MB seed window), any other shape falls through to a full parse so no output can be lost. Coverage tick `91a0843` then repaired that broken assertion — dropped the stray quote so the structural match pins the real line, and extended the test to exercise fmtUsdCap's rule by evaluating the helper pulled out of the served page (whole dollars stay bare, fractional caps keep their cents) — moving it to BUGS.md's Fixed section; readme tick 95 had recorded it as open from a pre-fix main before the repair landed. Clean tick `b77b3df` made dueForPrune module-private for lack of test usage, and feature tick 77 (`157215f`) then closed all three remainders of the live sessionRetentionDays plan — item (a) the `retention_changed` event per distinct value change (plain line beside its maxConcurrent sibling; rendering unit), item (b) `dueForPrune` re-exported with once-per-day gate units, and item (c) the live-edit e2e (tightening to 1 re-prunes within one poll with exactly one change event; loosening back logs a second event but prunes nothing; setting 0 disables rather than deletes — three events total for three distinct edits, unchanged polls log nothing) — moving it to Done in PLANS.md. Plan tick `d5c9531` then refined the already-done queued-prompts TUI/GUI entry against current main (five spec gaps closed at implementation time, recorded as a Refined section; docs only). Since then, feature tick `da86dbd` closed the director-inbox CLI plan — coverage tick `9c20312` had landed most of the spec'd CLI tests but was missing two clauses, so this tick added both to test/cli.test.ts (the unknown-double-dash-flag regression: `prompt --foo text` fails with an actionable error naming `--list, --cancel <n>` and leaves the inbox untouched; and single-dash positionals staying content: `prompt "-x"` enqueues `-x`, like init's bullets) plus a pin that parse-time failures enqueue nothing — moving the plan to Done in PLANS.md, leaving only the steward entry in its Planned section (dogfood observation is all that remains there). Dry tick `15b3f6e` then extracted the pre-write directory creation duplicated across six modules into two helpers in src/files.ts — `ensureDir(dir)` and `ensureParentDir(file)` — so every writer of harness state/log/inbox/session files goes through one place instead of its own mkdirSync. Current main (`15b3f6e`): suite 536/536 green (verified 2026-09-02).
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
`pi.ts` the pi subprocess integration, `git.ts` the git/worktree helpers, `merge.ts` the
rebase/fast-forward/conflict-resolution landing flow), `test/` unit tests.
Tests fake pi with a shell shim on PATH, so they run offline.
