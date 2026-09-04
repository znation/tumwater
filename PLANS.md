# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

### Section-aware tick reads — stop paying for history every tick (planned 2026-09-04)

Every loop's prompt says "First read README.md, PLANS.md, BUGS.md, and QUESTIONS.md (those that exist) to understand the project" (the two-line rule at the top of `COMMON_RULES` in src/prompt.ts), so each tick re-reads the backlog files whole. They grow without bound: PLANS.md is now 177KB with only ~17KB actionable — `## Planned` ends at line 116 and everything below is Done history — and BUGS.md is 59KB whose `## Open` section is currently empty, the rest being Fixed history. Recent pi logs show the feature loop offset-reading ALL of PLANS.md in every recent session (offsets up to ~line 1830 of 2126) while only its top matters for picking a plan; bugfix does the same for BUGS.md, and the plan loop reads it all too. That is roughly 45k tokens/tick for feature and plan and ~15k for bugfix spent on history no role needs to act on — concentrated in exactly the loops that run most often when there is work to do (hygiene roles mostly `head` the files, which is already cheap).

Fix it at the prompt level, where the reading behavior lives: rewrite that one COMMON_RULES line into a section-aware rule. README.md read in full; PLANS.md and BUGS.md never read wholesale — their actionable sections come first by template convention (init.ts puts `## Planned` before `## Done`, `## Open` before `## Fixed`), so read the top of each file (Planned plus recent Done; Open plus recent Fixed) and consult older history via git log or a targeted read only when a specific entry is needed; QUESTIONS.md as today. Add an explicit carve-out for the steward role, whose job is curating those files and which must see them whole. No roles.ts changes are needed: every role's find text already names what it opens ("Open PLANS.md and pick…", "Open BUGS.md and pick…") — the diet governs how much of each file gets read, not which files.

Relationship to other plans: this complements rather than duplicates the deferred curation siblings noted under the README status plan (steward compression of Done/Fixed). Curation bounds on-disk size; this rule bounds per-tick prefill, keeping it flat as history grows even before any curation lands. It also pairs with the pending "Bound README's status section" entry — same theme (prompt/prefill cost), different file: that one rewrites roles.ts's readme find text, this one rewrites prompt.ts's COMMON_RULES; no overlap.

Files touched: src/prompt.ts (the two-line "First read…" rule in `COMMON_RULES`); test/prompt.test.ts (update the existing contract assertion at ~line 368 that pins the old wording — `/First read README\.md, PLANS\.md, BUGS\.md, and QUESTIONS\.md/` — to pin the new clauses instead, oneLine-based like its neighbors).

Acceptance criteria:
- `npm run build` clean; full suite green.
- Contract tests assert each clause of the new rule in a tick prompt: README read in full; PLANS.md/BUGS.md not read wholesale with their actionable sections first; older history via git log or targeted reads; steward carve-out present.
- Observable within a few ticks after landing: feature, bugfix, and plan loops' peak ctx drops substantially (feature from ~90k toward README+Planned size) in the status table's "peak ctx" column and per-role pi logs, with hygiene roles unchanged or lower — steady-state prefill no longer scales with Done/Fixed history.

### Bound README's status section — state, not log (planned 2026-09-03)

**Goal.** The initial prompt says "First puts the initial prompt and project status into
README.md" — but the status section has drifted from *state* to *log*. It is now a single ~38.7KB
paragraph in a 52KB README (the file grew 13× in two weeks, 4KB → 52KB), accumulating per-tick
landing narrative ("Since then: X landed…") on every readme sync. Every loop's prompt says "First
read README.md", so each tick of all thirteen loops pays that cost in prefill — ~10k+ tokens of
non-actionable history, growing without bound, so per-tick cost grows forever for a fleet meant
to run for weeks. The narrative is redundant: PLANS.md's Done entries and BUGS.md's Fixed entries
carry the same landings with more detail (commit hashes, audits), and git log preserves every
version of README — no archive file is needed; git history *is* the archive. Fix: make the status
section a snapshot of current state that each sync rewrites wholesale instead of appending to, so
it stays small by construction.

**Approach.**
- src/roles.ts — rewrite the readme role's find text (today: "Update the status section … to
  reflect reality: what works, what is in progress, how to build/run/test") into an explicit
  contract:
  - The status section (between the tumwater:status markers) describes CURRENT STATE ONLY and is
    rewritten wholesale on each sync, never appended to: (a) a one-line version/capability summary
    (which commands exist, which roles are enabled), (b) open items — planned features not yet
    done, open bugs, open questions, one line each or "none", (c) the existing freshness-stamp
    convention (`Current main (\`<sha>\`): build clean, suite N/N`).
  - No per-tick landing narrative in the section: landings are recorded by their owning loops in
    PLANS.md/BUGS.md and git log — stale narrative found in the section is deleted as part of
    updating it (that is an update, not a loss).
  - Drift guard: if the section exceeds ~8KB it has drifted back into narrative — prune it to the
    state-only form above.
  - Keep the existing constraints: PRINCIPLES.md belongs to director/steward; never edit the
    tumwater:prompt block; "if the README is already accurate (including its freshness stamp),
    there is nothing to do" — a moved main makes the stamp stale, so syncs still run after landings.
- test/prompt.test.ts — a sibling contract block following the steward pattern (`const readme =
  roleById("readme")`, matching `oneLine(readme.find)` so assertions are reflow-robust): the
  rewrite-wholesale-not-append rule; the state-only content spec (capability summary, open items,
  freshness stamp); the no-narrative rule naming PLANS.md/BUGS.md and git log as where landings
  belong; the ~8KB drift guard. Also convert the existing readme assertion ("the readme role leaves
  PRINCIPLES.md to the director and steward", which matches a literal `\n` inside the find text)
  to match against `oneLine(...)` so the rewrite cannot break it on reflow.
- Transition (NOT this plan's implementer): the first readme sync after landing rewrites the
  current ~38KB paragraph into state-only form — a large md-only diff, review-exempt; the
  pre-collapse text stays in git history.

**Files touched.** src/roles.ts, test/prompt.test.ts. (README.md itself changes on a subsequent
readme tick under the new contract.)

**Acceptance criteria.**
- Contract tests (test/prompt.test.ts): the readme find text carries all four clauses —
  rewrite-wholesale-not-append; state-only content spec naming capability summary, open items,
  and freshness stamp; no-narrative rule with landings belonging in PLANS.md/BUGS.md and git log;
  ~8KB drift guard — each matched with whitespace collapsed; the existing readme assertion passes
  against the rewritten text.
- Build clean, full suite green.
- Transition verified by observation on a subsequent readme tick (not this plan's implementer):
  within a few readme ticks of landing, the status section is under 8KB and carries no per-tick
  landing narrative — only capability summary, open items, and freshness stamp; git log preserves
  the pre-collapse paragraph.

**Sibling concern, deliberately not planned here.** PLANS.md (~160KB) and BUGS.md (~57KB) carry
the same unbounded-history growth in their Done/Fixed sections, which every tick also reads. They
decompose into separate entries with different owners (steward curation for PLANS.md;
bugfix/steward for BUGS.md) and different policies (e.g. compressing a Done entry must wait until
nothing remains), and this README case is the sharpest instance to prove the pattern first —
revisit once it has landed.

**Refined 2026-09-03 (plan loop) — audited against current main (`548168d`); the transition
already landed ahead of this plan, so the goal is reframed from collapse to durability.**
Verified at `548168d`: every structural claim in the Approach still holds — src/roles.ts's readme
find text is byte-identical to what the entry quotes ("Update the status section … to reflect
reality: what works, what is in progress, how to build/run/test"); test/prompt.test.ts has no
readme contract block yet; its `oneLine` helper sits at line 326 and the steward pattern it tells
the implementer to follow (`const steward = roleById("steward")`, assertions on
`oneLine(steward!.find)`) is exactly as described (lines ~509–548); and the existing readme
assertion ("the readme role leaves PRINCIPLES.md to the director and steward", lines 182–185)
still matches a literal `\n` inside the find text, so the oneLine conversion is still required.
What changed: the Goal's size claims are stale. The transition this entry anticipated — rewriting
the ~38KB narrative paragraph into state-only form — already landed at `1f70a95`
("Rewrite status section as state-only snapshot at main f995ecb", 22 insertions / 112 deletions),
ahead of any contract in roles.ts: the README is now ~15.5KB and the status section ~1.9KB, well
under the 8KB guard, carrying exactly the spec'd shape (capability summary line, open items,
`Current main (\`<sha>\`)` freshness stamp). The collapse happened once because every tick prompt
tells its loop to read PLANS.md first (src/prompt.ts), where this entry spelled out the target
form; nothing enforces it going forward. The find text still
says "Update the status section … to reflect reality", which is what produced the original
"Since then: X landed…" appends — so absent this contract, subsequent syncs regrow the log and
every one of the thirteen loops pays it in prefill again. Corrected spec:

1. **Goal reframed.** The remaining problem is durability, not collapse: codify the state-only
   snapshot as an explicit contract in the readme role's find text so every future sync rewrites
   the section wholesale and cannot drift back into per-tick narrative — small by construction,
   with the ~8KB guard as the tripwire. The Goal's "~38.7KB paragraph in a 52KB README" framing is
   superseded; cite `1f70a95` as the one-off that proved the target form.
2. **Transition item retired.** The Approach's "Transition (NOT this plan's implementer)" bullet
   and the AC's "Transition verified by observation" criterion are already satisfied at `1f70a95`
   — remove them from the remaining work. Replace with a durability observation (still not this
   plan's implementer): on subsequent readme syncs after landing, the section stays under 8KB and
   gains no per-tick narrative; git log preserves both the pre-collapse paragraph and `1f70a95`.
3. **Use the landed form as the reference example.** The contract's content spec (capability
   summary / open items / freshness stamp) must match what `1f70a95` actually produced, so the
   prompt codifies practice rather than inventing a new shape; the implementer should read that
   commit's diff when writing the find text.
4. **Sibling numbers refreshed.** PLANS.md is now ~160KB and BUGS.md ~57KB (was ~150/~56) — same
growth, still deliberately not planned here.

Everything else in this entry stands unchanged: the four contract clauses, the roles.ts rewrite,
the test/prompt.test.ts work (new readme contract block + oneLine conversion of the existing
assertion), and the files-touched list. The plan remains independently pickable by the feature
loop as-is once these corrections are read with it.

## Done

### Run the project's own test suite in the deterministic pre-merge gate (planned 2026-09-04,
done 2026-09-04)

**Goal.** The pre-check that gates every code merge recognizes only `typecheck` and `build` npm
scripts — it never runs tests. tumwater itself declares no `typecheck`, so its own gate is a bare
`tsc`: type errors are caught, but test failures land on main. That is the recurring failure mode
in BUGS.md's Fixed section: "Tests red on main" / "Build broken on main" entries from 2026-08-27
to 2026-09-03 (feature ticks 44/49/52, organize tick 78, clean tick 91, feature tick 83), each
discovered only after landing by the readme loop and costing a bugfix tick plus a status sync.
Fix: make detection prefer `test` when declared, so the gate runs the project's canonical
verification — for tumwater, build + full node:test suite (~53 s measured in a worktree on
2026-09-04) — and a red suite is rejected before merge with the clipped output tail as
machine-generated reasons.

**Approach.**
- src/build-check.ts — `buildCheckFrom`: prefer `scripts.test`, then `typecheck`, then `build`
  (still exactly one script per gate run). Update the module header and function doc comments:
  the check is "the project's declared deterministic verification", following npm convention that
  `npm test` is the canonical verify command; note that for tumwater `test` subsumes `build`. All
  execution/classification behavior stays as-is: 300 s timeout → skipped (environmental, warn and
  proceed), nonzero exit → failed with clipped tail, no npm on PATH → skipped.
- test/build-check.test.ts — update "detectBuildCheck prefers typecheck over build when both
  scripts are declared" to pin the three-way preference (`test` > `typecheck` > `build`; keep a
  two-script case for typecheck-over-build); extend the malformed/scriptless fixture and comment
  ("neither a usable typecheck nor build") to include `test`.
- test/review.test.ts — the duplicated preference test (~line 355) gets the same update. Every
  other gate fixture declares only `build`, so their `build check failed (build)` rejection-text
  assertions stay valid unchanged; optionally extend one fixture to declare a failing `test`
  script and pin that it is selected and rejected with reasons starting
  `build check failed (test):`.
- Deliberately no config knob (opinionated defaults over configuration): a project whose `test`
  script hangs hits the existing timeout→skipped path, and a flaky suite produces loud
  deterministic rejections — that is the gate surfacing suite health, not a defect to work around;
the 3-strike discard cap bounds any damage. Do not weaken the gate to accommodate flakiness.

**Files touched.** src/build-check.ts, test/build-check.test.ts, test/review.test.ts. (The
README's "deterministic build pre-check" sentence stays accurate; the readme loop syncs wording if
it judges it stale.)

**Acceptance criteria.**
- detectBuildCheck returns `test` when all three scripts are declared, `typecheck` when only
  typecheck+build exist, and `build` alone as before — pinned by unit tests in both test files.
- A worktree whose package.json declares a failing `test` script is rejected by the gate with zero
  reviewer runs, reasons starting `build check failed (test):`, branch reset to main (existing
  rejection-path semantics: no pi run consumed, unreviewFailures reset).
- Build clean; full suite green — including running `npm test` with cwd = a tumwater worktree
  (feasibility verified by the plan loop on 2026-09-04: 599/599 in ~53 s, no local node_modules
  needed — npm's run-script walks up to the installed ancestor).

**Done 2026-09-04 (feature tick) — implemented as planned against main `48131e9`; nothing remains.**
Audited first: at `48131e9` no part had landed — `buildCheckFrom` still preferred only
`typecheck`/`build`, and both test files still pinned the two-script preference. This tick landed
all three Approach items in one change: src/build-check.ts's `buildCheckFrom` now prefers
`scripts.test`, then `typecheck`, then `build` (module header and doc comments updated per spec —
npm convention makes `test` the canonical verify command; for tumwater `test` subsumes `build`),
with execution/classification behavior untouched. test/build-check.test.ts's preference test now
pins the three-way order (all three declared → `test`; typecheck+build only → `typecheck`) and its
malformed/scriptless fixture includes a non-usable `test`. test/review.test.ts got the same
preference-test update, plus `gateBuildFixture` gained a script-name parameter and a new e2e —
"gate pre-check selects the declared test script — a failing suite rejects with zero reviewer
runs": a worktree declaring a failing `test` script is rejected deterministically (no pi run,
branch reset to main, unreviewFailures reset) with reasons starting `build check failed (test):`.
The Approach's optional fixture extension was taken; every other gate fixture still declares only
`build`, so its `(build)` rejection-text assertions are unchanged. Consequence: from this landing
onward tumwater's own pre-merge gate runs its full suite (`npm test` = build + node:test) instead
of bare `tsc`. Verified on this tree: build clean, full suite 600/600 in ~51 s (main's 599 plus
this tick's one new test). Files: src/build-check.ts, test/build-check.test.ts,
test/review.test.ts, PLANS.md.

### Abort a single loop's in-flight tick — `tumwater abort --role <id>` (planned 2026-09-03,
refined 2026-09-03, re-audited 2026-09-03, re-audited 2026-09-04, done 2026-09-04)

**Goal.** Give operators a way to stop ONE loop's in-flight tick right now — without stopping the
whole fleet or waiting for the hang guards. Today, when a loop is visibly thrashing on a bad task
(the transcript pane shows it) or burning money on a doomed run, the only levers are Ctrl+C (kills
every loop), editing tumwater.json to disable the role (blocks NEW ticks only — `isEligible` gates
starts; an in-flight tick still runs to completion), or waiting for the quiet watchdog / tick
timeout to fire. `tumwater abort --role <id>` closes that gap: kill this loop's current pi run,
discard its half-done work (worktree reset to main), and let it go back to normal scheduling — the
loop stays enabled, later ticks proceed as usual. One cohesive feature: the marker-file contract
couples the CLI, the orchestrator, and the loop, so no part is independently shippable.

**Approach.**
- src/paths.ts: `abortRequestPath(root, role)` → `.tumwater/abort-<role>.json` — a per-role marker
  file following the `reset-counters.json` pattern (presence = pending request; content `{ at }`).
  Per-role files keep consumption race-free and need no parsing.
- src/types.ts: add `"user_aborted"` to TickResult ("a user-initiated abort killed the run
  mid-tick; work discarded, loop backed off") — deliberately distinct from `"aborted"` (harness
  shutdown), which carries resume-promptly semantics a deliberate stop must not have. Add
  `"tick_aborted"` to HarnessEvent's type union (routine state change, like counters_reset).
- src/loop.ts: LoopRunner gains a private per-tick `AbortController`, created at tick start
  alongside the counter resets; runRolePi and reviewGate pass the COMBINED signal —
  `this.signal ? AbortSignal.any([this.signal, this.tickAbort.signal]) : this.tickAbort.signal`
  (engines require Node ≥ 20). New method `abortTick()`: no-op when no tick is in flight
  (`state.running` false); otherwise sets a private `userAborted` flag and calls
  `tickAbort.abort()`. The flag is cleared at the next tick start. In runTick's two abort branches
  (the author-run `pi.aborted` check and the review-gate `gate.aborted` check): when `userAborted`,
  diverge from shutdown semantics — reset the worktree to main (`resetWorktreeToMain`, discarding
  half-done edits AND any unmerged commit on the branch, so the next tick's leftover recovery finds
  nothing), do NOT requeue a director prompt (an explicit abort is a decision about that request;
  timeouts and cut-offs still requeue), and return `{ result: "user_aborted" }` instead of
  `{ result: "aborted" }`. Known limitation, document in the code comment: if the marker is consumed
  while the tick sits in its short git-only commit/merge window (no pi run in flight), the flag
  takes effect at the next model-run boundary within the tick — or, for a tick that reaches no
  further pi run, completes normally and the abort had no effect; re-issuing is the remedy.
- src/state.ts: applyTickOutcome gains a `"user_aborted"` branch — schedule like an unproductive
  tick (the final else's `nextBackoffSeconds` backoff), no `resumePending`; phase is already cleared
  by the existing `result !== "aborted"` check.
- src/orchestrator.ts: in the poll cycle beside the reset-counters marker consumption — for each
  role with a pending abort marker file, find its runner; if `runner.state.running`, call
  `runner.abortTick()` and log one `{ loop: role, type: "tick_aborted" }` event; remove the marker
  either way (a request for an idle loop is a no-op, not an error).
- src/event-format.ts: render `tick_aborted` as a plain line like counters_reset —
  `<time> <role> tick aborted by user`; tick_end renders its result string verbatim, so
  `"user_aborted"` flows through with no change.
- src/cli.ts: new `abort` subcommand following reset-counters' pattern —
  `rejectUnknownArgs("abort", args, [{ names: ["--role"], value: true, valueName: "<id>" }])`,
  `requireReadyRepo`; `--role <id>` required and must be a known role id (actionable error listing
  the valid ids otherwise); require the orchestrator to be running (`readOrchestratorInfo` +
  pidAlive — actionable "no harness is running" error, since with no fleet nothing consumes the
  marker); write the marker; confirm `abort requested for <role> — a running fleet applies it
  within ~2s`. README.md: one Usage line (do not touch the status block — that text belongs to the
  readme loop).

**Files touched.** src/paths.ts, src/types.ts, src/loop.ts, src/state.ts, src/orchestrator.ts,
src/event-format.ts, src/cli.ts, test/loop.test.ts, test/state.test.ts, test/orchestrator.test.ts,
test/event-format.test.ts, test/cli.test.ts, README.md.

**Acceptance criteria.**
- Loop e2e (test/loop.test.ts): a fake-pi shim that hangs mid-run — `runner.abortTick()` kills the
  child; the tick ends with result "user_aborted"; the worktree is reset to main (a planted dirty
  file is gone); persisted state carries no resumePending and nextRunAt > now (backed off, not
  immediate); the tick_end event carries user_aborted. Director variant: an aborted director tick
  leaves the inbox EMPTY — its prompt was not requeued (contrast with timeout/cut-off, which do).
- Orchestrator e2e (test/orchestrator.test.ts): a slow fake-pi tick under a real orchestrator;
  writing `abortRequestPath(root, role)` kills the run within one poll cycle, removes the marker,
  and logs exactly one tick_aborted event; a marker for an idle loop is removed with no event.
- Scheduling units (test/state.test.ts): applyTickOutcome("user_aborted") advances backoff like an
  unproductive tick, sets no resumePending, clears phase.
- Events (test/event-format.test.ts): tick_aborted renders as a plain line under the role's loop;
  tick_end with result user_aborted renders that string.
- CLI (test/cli.test.ts): `abort --role feature` against a running harness writes the marker and
  confirms; without a running harness it fails actionably naming `tumwater run`; an unknown role
  fails listing valid ids; missing/unknown flags fail like reset-counters' siblings.
- Build clean, full suite green.

**Refined 2026-09-03 (plan loop) — audited against current main (`67fb3d9`); three spec gaps
closed.** Every structural claim verified on current main first: `resetRequestPath(root)` in
src/paths.ts is the marker template; TickResult and HarnessEvent's unions sit where described;
LoopRunner's constructor takes a `signal?: AbortSignal`, runRolePi and reviewGate both pass it
through, and pi.ts already handles a pre-aborted signal (`opts.signal?.aborted` → immediate
onAbort), so the documented "next model-run boundary" limitation is accurate; the tick-start
counter-reset block (generatedTokens/peakContextTokens/tickTurns/tickCostUsd zeroed in tick()) is
the anchor for creating the per-tick AbortController; runTick's two abort branches are exactly as
described — the author-run `pi.aborted` check and the review-gate `gate.aborted` check, each
requeueing then returning `{ result: "aborted" }`; applyTickOutcome's final else is the backoff
branch and its `result !== "aborted"` phase-clear covers `"user_aborted"` as claimed; the
orchestrator poll cycle consumes the reset-counters marker beside where this entry sits (runners
are an array — look one up by role); event-format renders tick_end's result verbatim and
counters_reset as a plain line; every CLI helper named exists (`rejectUnknownArgs`/
`parseRoleFlag` in src/cli-args.ts, `requireReadyRepo` in cli.ts, `readOrchestratorInfo` in
state.ts, `pidAlive` in process.ts); and `resetWorktreeToMain` (src/git.ts) does abortSync +
`git reset --hard <main>` + `git clean -fd`, which moves the branch pointer back to main — so it
discards unmerged commits as well as dirty files, exactly as this entry claims. Three gaps in
the original spec, corrected:

1. **`pendingUserPrompt` must be cleared on a user-abort of the author run.** The existing
   `pi.aborted` branch returns before tick()'s `this.pendingUserPrompt = null`, so today an
   aborted director tick leaves its dequeued prompt held on the live runner (harmless under
   shutdown — the process dies and the prompt was requeued — but a user-abort in a running
   orchestrator neither requeues nor clears it). No functional bug today: every non-skipped
   director tick calls tickPrompt() first, which overwrites the field before its sole read site —
   but that makes the discard accidental rather than explicit. Pin: in the author-run branch's
   `userAborted` divergence, clear `this.pendingUserPrompt = null` alongside skipping the requeue.
   The review-gate branch needs no such clearing — by then tick() has already cleared it.
2. **The no-runner case is unspecified.** Runners are built from enabled roles only, so a
   valid-but-disabled role id has no runner at all — `tumwater abort --role <disabled>` reaches
   the poll cycle with a marker but nothing to find. Pin: treat it like an idle loop — remove the
   marker, log no event; the CLI's confirmation is unchanged (the request was accepted and
   consumed). The orchestrator AC's "marker for an idle loop" case covers this shape — assert it
   with a disabled role too.
3. **The director prompt discard is invisible to the user.** The inbox is a file queue and
   dequeuePrompt removes the prompt file at tick start, so a discarded prompt is gone from disk —
   but the planned confirmation ("abort requested for <role> …") says nothing about it. Pin: when
   `--role` is the director, append one clause to the CLI confirmation that its current in-flight
   prompt will be discarded (re-submit with `tumwater prompt` if you want it retried).

**Re-audited 2026-09-03 (plan loop) — feature tick 87 (`b37e600`) landed the entire src half;
two of the three refined pins were missed and no AC tests exist. Remainder re-specified.**
Verified at `1f70a95` (build clean, suite 587/587): every Approach file is present as specified —
`abortRequestPath` (`abort-<role>.json`) in src/paths.ts; both union members in src/types.ts;
src/loop.ts's per-tick `AbortController` created at tick start beside the counter resets,
`runSignal()` combining it with the harness signal via `AbortSignal.any`, `abortTick()` (no-op
when idle, else flag + abort), and the `userAborted` divergence in BOTH runTick abort branches
(`resetWorktreeToMain`, no requeue, `{ result: "user_aborted" }`); src/state.ts's
applyTickOutcome branch (backoff like an unproductive tick, no resumePending, phase cleared by
the existing `result !== "aborted"` check); the orchestrator's marker consumption beside the
reset-counters one — running → `abortTick()` + exactly one `tick_aborted` event, idle/disabled/
no-runner → marker removed silently (gap #2 implemented as pinned); src/event-format.ts's plain
line `<time> <role> tick aborted by user`; and src/cli.ts's cmdAbort (`parseRoleFlag` with the
valid-ids error, `requireReadyRepo` in main()'s dispatch, `orchestratorAlive` gate naming
tumwater run, marker write, confirmation) plus the README Usage line. Two pins from the
2026-09-03 refinement were NOT implemented:

1. **`pendingUserPrompt` is not cleared on a user-abort of the author run** (gap #1). The
   `userAborted` branch in src/loop.ts returns `{ result: "user_aborted" }` before the shared
   `this.pendingUserPrompt = null`, so an aborted director tick leaves its dequeued prompt held
   on the live runner. Non-functional per this entry's own analysis — every non-skipped FRESH
   director tick calls tickPrompt() first, which overwrites the field before its sole read site,
   and a user-abort never sets resumePending so no resumed tick can follow one — but the discard
   is accidental rather than explicit, as pinned.
2. **The CLI confirmation carries no director clause** (gap #3). cmdAbort writes an unconditional
   `abort requested for <role> — a running fleet applies it within ~2s`; with `--role director`
   its in-flight prompt is discarded from disk with no warning — exactly the invisibility gap #3
   was written to close.

What remains — seven items: (a)–(b) are small src fixes for the missed pins, (c)–(g) are the AC
test groups. (c)–(f) are pure test work against landed behavior and independently pickable TODAY;
(g)'s clause assertion needs (b), and (c)'s field-clearing assertion needs (a):

(a) **Clear `pendingUserPrompt` on a user-abort of the author run** (src/loop.ts): in the
   `userAborted` branch inside `if (pi.aborted)`, set `this.pendingUserPrompt = null` alongside
   skipping the requeue — one line, with a comment that an explicit abort discards the request.
   The review-gate branch needs no change (tick() has already cleared it by then).
(b) **Director clause in the CLI confirmation** (src/cli.ts): when the role is director
   (`DIRECTOR_ROLE` from roles.js), append one sentence to cmdAbort's confirmation that its
   current in-flight prompt will be discarded — re-submit with `tumwater prompt` if you want it
   retried. Non-director output stays byte-identical.
(c) **Loop e2e** (test/loop.test.ts): per the AC above — a fake-pi shim that hangs mid-run;
   `runner.abortTick()` kills the child; result "user_aborted"; a planted dirty file is gone
   (worktree reset); persisted state carries no resumePending and nextRunAt > now (backed off,
   not immediate); the tick_end event carries user_aborted. Director variant: an aborted director
   tick leaves the inbox EMPTY, and — after item (a) — the runner's `pendingUserPrompt` field is
   null (reachable via the `(runner as unknown as { … })` pattern this file already uses).
(d) **Orchestrator e2e** (test/orchestrator.test.ts): per the AC above — a slow fake-pi tick
   under a real orchestrator; writing `abortRequestPath(root, role)` kills the run within one poll
   cycle, removes the marker, and logs exactly one tick_aborted event; a marker for an idle loop
   is removed with no event — assert that case with a DISABLED role too (the no-runner shape).
(e) **Scheduling units** (test/state.test.ts): applyTickOutcome("user_aborted") advances backoff
   like an unproductive tick, sets no resumePending, clears phase.
(f) **Events** (test/event-format.test.ts): tick_aborted renders as a plain line under the role's
   loop; tick_end with result user_aborted renders that string verbatim.
(g) **CLI** (test/cli.test.ts): per the AC above — `abort --role feature` against a running
   harness writes the marker and confirms; without a running harness it fails actionably naming
   tumwater run; an unknown role fails listing valid ids; missing/unknown flags fail like
   reset-counters' siblings. Plus, after item (b): `--role director`'s confirmation carries the
   discard clause while a non-director's does not.
Once all seven land, move this plan to Done. Files for the remainder: src/loop.ts, src/cli.ts,
test/loop.test.ts, test/orchestrator.test.ts, test/state.test.ts, test/event-format.test.ts,
test/cli.test.ts.

**Re-audited 2026-09-04 (plan loop) — items (c) and (g) have LANDED; the "seven items" list
above is stale. Remainder re-specified as five items plus two small assertions.** Verified at
`70ebbc3` (current main; build clean, suite 594/594 run on this tick's tree — the two commits
since the README's `bd7df5e` stamp are a readme sync and an annotation-only clean tick):

- **(c) landed** in coverage tick `6b52731` — three tests in test/loop.test.ts: "a user-aborted
  tick discards work, backs off, and does not resume" (fake pi writes a half-done edit then hangs;
  `abortTick()` kills it; result "user_aborted"; the planted dirty file is gone from the worktree
  and nothing lands on main; no resumePending; backoffSeconds at the initial idle value with
  nextRunAt > now; tick_end carries user_aborted), "a user-aborted director tick drops the prompt
  instead of re-queueing it" (inbox empty after the abort — but does NOT yet assert the runner's
  `pendingUserPrompt` field is null, since item (a) has not landed), and a third test beyond the
  AC spec, "a user-abort mid-review discards the committed work too" (abort during the review
  gate: branch reset to main, no requeue, backed off).
- **(g) landed** in coverage tick `0d4c41b` — three tests in test/cli.test.ts: "abort validates
  its arguments before touching anything" (missing/bare --role, unknown role listing valid ids,
  unknown flag, stray positional; no marker on any failure), "abort refuses when no harness is
  running — missing or stale info file alike", and "abort drops a per-role marker for a live
  harness and reports it" (marker content `{ at }`, other roles' markers untouched, the CLI itself
  logs no event). The director-clause assertion is still absent — it waits on item (b), exactly as
  planned.
- **(a), (b), (d), (e), (f) verified NOT landed**: src/loop.ts's `userAborted` branch in the
  author-run abort check still returns `{ result: "user_aborted" }` before the shared
  `this.pendingUserPrompt = null`; cmdAbort's confirmation is unconditional (no director clause);
  test/orchestrator.test.ts carries no abort-marker tests; test/state.test.ts and
  test/event-format.test.ts have zero references to user_aborted/tick_aborted.

What remains — five items, pickable independently: (a), (b), (d), (e), and (f) exactly as
specified above (their specs stand unchanged). Plus two small assertions that complete the landed
test groups once their src fixes exist:

- **The tail of item (c)** — after item (a) lands, extend test/loop.test.ts's "a user-aborted
  director tick drops the prompt instead of re-queueing it" to also assert the runner's
  `pendingUserPrompt` field is null, via the `(runner as unknown as { … })` pattern this file
  already uses. One assertion; makes the discard explicit rather than accidental, per item (a)'s
  rationale.
- **The tail of item (g)** — after item (b) lands, add to test/cli.test.ts: `--role director`'s
  confirmation carries the discard clause while a non-director role's does not (the clause half of
  item (g)'s spec that could not land before (b)).

One note for whoever lands (d): test/loop.test.ts's comment block above its user-abort tests says
"The marker-file plumbing that reaches here is covered by the orchestrator tests" — aspirational
until (d) exists; landing (d) makes it true.

Once all five items plus both assertions land, move this plan to Done. Files for the remainder:
src/loop.ts, src/cli.ts, test/orchestrator.test.ts, test/state.test.ts, test/event-format.test.ts,
test/loop.test.ts (the item-(c) tail only), test/cli.test.ts (the item-(g) tail only).

**Done 2026-09-04 (feature tick) — all remainder items have landed; nothing remains.** The last five
items plus both assertion tails closed in one feature tick against main `7a9fa8d`: (a) the author-run
`userAborted` branch in src/loop.ts now clears `pendingUserPrompt` explicitly alongside skipping the
requeue, making the discard explicit rather than accidental; (b) cmdAbort appends a discard clause to
its confirmation for `--role director` only — non-director output stays byte-identical. The item-(c)
tail extends test/loop.test.ts's aborted-director test to assert the runner's `pendingUserPrompt` is
null via the file's existing cast pattern; (d) test/orchestrator.test.ts gains the marker-plumbing e2e —
a slow fake-pi tick under a real orchestrator, where writing `abortRequestPath(root, role)` kills the run
within one poll cycle with exactly one `tick_aborted` event, and markers for an idle loop AND disabled
(no-runner) roles are removed silently; (e) test/state.test.ts pins applyTickOutcome("user_aborted") —
initial-then-grown idle backoff, no resumePending, phase cleared; the item-(g) tail adds the
director-clause confirmation test to test/cli.test.ts. Item (f) landed in coverage tick `7a9fa8d`
(formatEvent tests for both lines, plus a partial-spend variant). Verified on this tree: build clean,
full suite 599/599.

### Per-loop today spend — which loop is eating the day's budget (planned 2026-09-02, done
2026-09-03)

**Goal.** Both dashboards show each loop's *today* spend alongside its lifetime cost. The
daily-budget badge shows fleet-wide today-spend (`· budget: $12.34/$50 today`), and per-tick
usage lines (the just-done "Per-tick usage in the event feed" plan) show individual ticks — but
nothing answers "which loop spent the day?" at a glance. When `budget paused` fires or the badge
nears its cap, an operator must sum tick_end lines by hand to see that one thrashing feature loop
is at $30 while every other loop sits at $0.10. A per-loop `today` column completes spend
observability: the cap tells you when the fleet stops, tick lines tell you where a single tick went,
and this column tells you which loop is burning the day's budget.

**Approach.**
- src/status-render.ts: add a `today` column to the shared table between `cost` and `last tick`,
  rendering `$<dailyCost(s).toFixed(2)>` — the existing tested helper in state.ts (same two-decimal
  format as the cost column; a stale or missing day-stamp reads $0.00, so loops that never ticked or
  last ticked yesterday show zero). The totals row sums it with `fleetDailyCost(snap.loops)` — by
  construction equal to the header badge's spend while enabled, a cross-check worth pinning in tests.
  FLEXIBLE_COLUMNS indices shift (last result 8→9, last tick 7→8); `today` is not flexible (short
  fixed-width cell like cost).
- src/gui.ts: statusPayload carries `todayUsd: dailyCost(s)` per loop beside the existing `costUsd`.
- src/gui-page.ts: `<th>today</th>` after `cost`, cell `$<l.todayUsd.toFixed(2)>` (the page already
  formats cost client-side from the payload — same pattern).
- No snapshot change needed: LoopState already carries dayStamp/dayCostUsd and both surfaces read it
  fresh per poll. The column renders whether or not the budget cap is enabled — spend observability
  does not depend on the cap.

**Files touched.** src/status-render.ts, src/gui.ts, src/gui-page.ts, test/status-render.test.ts,
test/gui.test.ts.

**Acceptance criteria.**
- TUI/one-shot (test/status-render.test.ts): the table header carries `today` between `cost` and
  `last tick`; a loop whose state file holds today's stamp renders its dayCostUsd in that cell
  ($0.00 when zero); a loop with a stale (yesterday) or missing stamp renders $0.00; the totals row's
  today cell equals fleetDailyCost across loops — asserted equal to snap.budget.spentUsd while the
  budget is enabled, so table and badge cannot drift; narrow-width rendering still never wraps (the
  new column participates in width computation like its siblings).
- GUI (test/gui.test.ts): /api/status carries `todayUsd` per loop (0 for a stale stamp); the served
  page's loop table has a `today` header cell and renders `$<value>` from it.
- Build clean, full suite green.

**Re-audited 2026-09-03 (plan loop) — the code half has LANDED in feature tick 83 (`c17893d`) but
its test updates did not; main's suite is red because of it. Remainder re-specified.** The Approach
above is stale on current main: everything it describes already exists, and no part of it should be
re-implemented. Verified at `86e6559` (build clean, suite 553/555 — the two failures below):

- **src/status-render.ts** — `today` sits between `cost` and `last tick` in `cols`, rendered as
  `$${dailyCost(s).toFixed(2)}` per loop; the totals row's today cell is
  `$${fleetDailyCost(snap.loops).toFixed(2)}`, with a comment pinning that it equals the header
  badge's spend while enabled. `FLEXIBLE_COLUMNS` renumbered exactly as this entry anticipated —
  last result 8→9, last tick 7→8 — and `today` (index 7) is not flexible, like `cost`, per its doc
  comment.
- **src/gui.ts** — statusPayload carries `todayUsd: dailyCost(s)` beside `costUsd`.
- **src/gui-page.ts** — `<th>today</th>` after `cost`; the cell renders client-side as
  `$" + l.todayUsd.toFixed(2)`, same pattern as cost.

The src-only landing broke two pre-existing layout assertions that address the table positionally or
by header order, leaving main's suite red (553/555 at `86e6559`; it was 551/553 at `c17893d` before
coverage tick `86e6559` added one passing test). This is recorded in BUGS.md's Open section —
"Tests red on main: feature tick 83's `today` column broke two layout assertions" — whose own fix
note anticipates being folded into this plan's test items. What remains — three items, pickable
independently (all pure test work; no src/ change is needed):

(a) **repair the two broken layout assertions** (the open bug above; landing it makes main green
again and moves that BUGS.md entry to Fixed). test/gui.test.ts "the dashboard page has a last tick
column between cost and last result" (~line 270): its header regex must include the new column —
`/<th>cost<\/th><th>today<\/th><th>last tick<\/th><th>last result<\/th>/`. test/status-render.test.ts
"last tick shrinks last: narrow width takes from last result, then state, then last tick" (~line 191):
renumber the positional indices for the new index-7 `today` column — last tick is now 8 (the fixture-
sanity assertion becomes `col(natural, 8)` = 17) and last result is now 9 (`col(w, 9)` / `col(
natural, 9)` in all three stages); the stage logic and the final 80-column no-wrap loop are
unchanged. If a bugfix loop lands this first, item (a) is done and only (b)–(c) remain.
(b) **the TUI/one-shot AC tests** in test/status-render.test.ts — `snapshotWith` takes partial
LoopState objects, so no file seeding is needed: the header row carries `today` between `cost` and
`last tick`; a loop with `dayStamp = todayStamp()` and `dayCostUsd = 12.34` renders `$12.34` in its
today cell (fresh stamp, zero spend → `$0.00`); a stale stamp (`todayStamp(Date.now() - 86_400_000)`)
with positive `dayCostUsd` and the freshLoopState default (missing stamp) both render `$0.00`; the
totals row's today cell equals `fleetDailyCost` across loops — with two fresh-stamp loops summing to
X and `snapshotWith(loops, { spentUsd: X, capUsd: 50 })`, assert the totals cell reads `$X`, equal
to the badge spend so table and badge cannot drift; under overflow the today column keeps its
natural width (non-flexible, like cost) while the flexible columns shrink.
(c) **the GUI AC tests** in test/gui.test.ts — mirror the file's existing budget-test pattern
(`freshLoopState`/`saveLoopState`/`todayStamp` are already imported): /api/status carries `todayUsd`
per loop — a state file with today's stamp and `dayCostUsd = 12.34` reads 12.34, a stale-stamp file
with positive spend reads 0; the served page renders the cell client-side from it (match GUI_PAGE on
`l.todayUsd.toFixed(2)` beside its existing cost assertion). The header-cell half is item (a)'s
regex.
Once all three land, move this plan to Done. Files for the remainder: test/status-render.test.ts,
test/gui.test.ts (plus BUGS.md's Open→Fixed move with item (a)).

**Done 2026-09-03 (feature tick) — the test remainder has landed; nothing remains.** The src half
had already landed in feature tick 83 (`c17893d`) per the re-audit above, so this is pure test work.
Item (a): both broken layout assertions repaired — gui.test.ts's header regex now pins
`<th>cost</th><th>today</th><th>last tick</th><th>last result</th>` and status-render.test.ts's "last
tick shrinks last" renumbered its positional indices for the index-7 `today` column (last tick 7→8,
last result 8→9) — which also moves BUGS.md's "Tests red on main: feature tick 83's `today` column
broke two layout assertions" entry to Fixed. Item (b): four TUI/one-shot tests in
test/status-render.test.ts — the header carries `today` between `cost` and `last tick`; a fresh-stamp
loop renders its dayCostUsd ($12.34) with lifetime cost still a separate $0.00 column, while stale-
and missing-stamp loops render $0.00; the totals row's today cell sums the fresh windows only
($13.00 = 12.34 + 0.66, the stale loop excluded), asserted equal to the header badge's spend on the
same render so table and badge cannot drift; and under overflow the today column keeps its natural
width (never flexible) while last result shrinks, like cost. Item (c): two GUI tests in
test/gui.test.ts — /api/status carries `todayUsd` per loop (12.34 for a fresh-stamp state file, 0
for stale and missing windows), and the served page renders its cell client-side from
`l.todayUsd.toFixed(2)` beside cost. Verified on this tick's tree: build clean, full suite 560/560
(main was red at 552/554 before it). Files: test/status-render.test.ts, test/gui.test.ts, PLANS.md,
BUGS.md.

### Steward role — whole-system judgment on a slow clock (planned 2026-08-24, refined 2026-08-25,
refined 2026-08-27, audited 2026-08-28, re-audited 2026-08-30, re-audited 2026-08-30
(item (a)'s file reference updated), re-audited 2026-08-31 (item (b2) landed),
re-audited 2026-09-02 (items (a), (b1), (b3) landed), done 2026-09-02)

Full plan: [plans/steward-role.md](plans/steward-role.md). A markdown-only `steward` role on a
~6 h cadence (per-role `minTickIntervalSeconds` override of the existing global knob, resolved via
configForRole at all read sites; enabled by default with no config edit) that re-reads the initial
prompt, PRINCIPLES, PLANS, BUGS, and the codebase's shape, then makes one curation move: prune/
merge plans (the only role allowed to delete entries), flag drift, keep the complexity budget
honest. The tech-lead layer the "projects disintegrate past tens of kLOC" reports say becomes
mandatory.

**Status (plan-loop audit 2026-08-28):** feature tick 49 (`6e3f487`) landed the full design;
verified at `ceb6019` with a green build and a 338/338 suite. Catalog: steward is last in ROLES
(after `improve`; the director is appended separately by `allRoleIds()`), so it has exactly the
lowest tie-break priority planned. Defaulting: `defaultConfig()` carries
`{ enabled: true, minTickIntervalSeconds: 21600 }` and `loadConfig` merges per-role defaults for
ids absent from the file — this repo's tumwater.json lists every other role but not steward, so it
enables with no config edit. Validation: `minTickIntervalSeconds` is in ROLE_ENTRY_KEYS with a
`checkNumber … >= 0`. Resolution: `configForRole` falls back per-role → global; `isEligible`
reads through it, so the slow clock gates both scheduled ticks and "main moved" early wakes;
tick() resolves once at the top and uses it in every interval branch — the three planned branches
(changed/skipped/cut-off-resume) plus review-gate's later-added `rejected` branch (scheduled like
changed), while aborted/backoff are untouched as planned. Prompt: curation move list, markdown-
only restriction, PLANS.md deletion / PRINCIPLES.md edit powers, and the conditional QUESTIONS.md
mention are all present in roles.ts; md-only diffs stay review-exempt via the gate's `*.md` /
`docs/**` paths. Remaining — test gaps against the acceptance criteria plus the dogfood
observation, nothing structural: (a) no role prompt contract tests exist — the plan's
test/steward.test.ts never landed; add assertions for the curation move list, markdown-only
restriction, deletion/principles powers, and conditional QUESTIONS.md mention; (b) the per-role
interval is untested at scheduler level — only `configForRole` resolution has a regression test
(test/config.test.ts); add an orchestrator-level test that a shortened override gates
`isEligible`'s min-gap (including early wakes) and loop tests that tick()'s nextRunAt branches
honor the override with global fallback when unset; (c) dogfood pending: no `tumwater(steward)`
commit in history as of this audit, and PRINCIPLES.md's Budgets section is still absent — note
the running fleet process must have started after 6e3f487 for its compiled defaultConfig to
include steward (JS loads at startup; same consideration as the commit-bodies trailer note).
Files for the remainder: test/steward.test.ts (new), test/orchestrator.test.ts, test/loop.test.ts.

**Re-audited 2026-08-30 (plan loop) — item (b)'s spec is stale on current main; remainder re-
specified.** The "loop tests that tick()'s nextRunAt branches honor the override" half of item (b)
names code that has since moved: organize tick `225c1d9` extracted post-tick scheduling out of
loop.ts into the pure `applyTickOutcome(s, cfg, role, outcome)` in src/state.ts — tick() now
resolves `cfg = configForRole(this.config, this.role)` once at the top and passes it through. And
test/state.test.ts already unit-tests every interval branch (changed; rejected + skipped;
cut-off-resume under and over the streak limit) against a plain config's
`minTickIntervalSeconds`, so "the branches read cfg.minTickIntervalSeconds" is covered — as is
item (b)'s global-fallback half, by test/config.test.ts's configForRole assertions (steward 21600,
qa 7200, every other role inherits the global). What actually remains against AC3 — three items,
pickable independently:

(b1) **the resolution chain through a real tick** in test/loop.test.ts — one e2e pinning
configForRole → applyTickOutcome end to end: a role with a per-role `minTickIntervalSeconds`
override distinct from the global (e.g. 3600 over a fast global) lands a changed tick; assert the
persisted state's `nextRunAt - lastTickEndedAt ≈ 3600 s`, not the global interval. This is the only
untested link in the chain: applyTickOutcome's branches are unit-covered, configForRole's
resolution is unit-covered, and nothing yet proves tick() hands the resolved value to the
scheduler.
(b2) **isEligible's min-gap with a per-role override** in test/orchestrator.test.ts — a variant of
"a sleeping loop wakes when main moves, respecting the min gap" (which exercises only the global
knob): a role whose per-role override is large (e.g. 3600) over a small global stays ineligible
across a main-moved wake while inside the window even though its nextRunAt has passed — proving
the read site resolves per-role rather than reading `config.minTickIntervalSeconds` directly; the
inverse (small override, large global) wakes at the shorter value.
(b3) **AC3's validation clause** in test/config.test.ts — no assertion rejects a negative per-role
`minTickIntervalSeconds`: add one to "validateConfig reports every invalid value in one error"
(or a sibling), e.g. `roles.feature.minTickIntervalSeconds = -5` → an actionable error naming the
field, like its siblings' existing assertions.

AC3's "applies live on tumwater.json edits (no restart)" is recorded as a structural guarantee
rather than tested: runners' config objects are replaced on every ~2 s poll — e2e-tested for role
fields by the live-reload plan ("mid-run model edits reach pi's --model") — and both read sites
(`isEligible`'s min-gap, tick()'s top-of-tick resolution) call `configForRole(runner.config, …)`
at call time, so a cadence edit applies from the next eligibility check or tick with no restart.
Item (a) (prompt contract tests in test/steward.test.ts — curation move list, markdown-only
restriction, deletion/PRINCIPLES powers, conditional QUESTIONS.md mention; catalog order last)
and item (c) (dogfood: still no `tumwater(steward)` commit on main as of this audit,
PRINCIPLES.md's Budgets section still absent) are unchanged. Files for the remainder:
test/steward.test.ts (new), test/loop.test.ts, test/orchestrator.test.ts, test/config.test.ts.

**Re-audited 2026-08-30 (plan loop) — item (a)'s file reference is stale on current main;
remainder otherwise verified.** The "test/steward.test.ts (new)" target above is stale: organize
tick `c3779b8` merged qa-role.test.ts into the module-named test files, so role prompt contract
tests now live in test/prompt.test.ts (the qa block there: `const qa = roleById("qa")` plus
assertions over its find text). Item (a) therefore lands as a sibling block in test/prompt.
test.ts, not a new file — `const steward = roleById("steward")`, then the same four assertion
groups: catalog order last (`ids[ids.indexOf("improve") + 1] === "steward"`, with the director
appended separately by allRoleIds) plus title; curation move list (delete/merge stale PLANS.md
entries with a one-line epitaph, flag drift as a PLANS.md note, tighten or update a principle or
complexity budget in PRINCIPLES.md, record a structural risk in BUGS.md); markdown-only
restriction ("You edit only markdown — never source."); conditional QUESTIONS.md mention ("and
QUESTIONS.md if it exists"). Match content with whitespace collapsed, not layout — the find text
is hard-wrapped and the tick-57 reflow break is the cautionary tale. Items (b1)–(c) verified
unchanged on `c3779b8`: applyTickOutcome still at src/state.ts:121; the named orchestrator test
"a sleeping loop wakes when main moves, respecting the min gap" exists in test/orchestrator.
test.ts; the named config test "validateConfig reports every invalid value in one error" exists
in test/config.test.ts; test/loop.test.ts still has zero references to minTickIntervalSeconds;
and dogfood is still pending — no `tumwater(steward)` commit on main, PRINCIPLES.md's Budgets
section still absent. Files for the remainder: test/prompt.test.ts, test/loop.test.ts,
test/orchestrator.test.ts, test/config.test.ts.

**Re-audited 2026-08-31 (plan loop) — item (b2) has LANDED; remainder is (a), (b1), (b3), and
dogfood (c).** The "three items, pickable independently" list above is stale on current main
(`2b294a2`): coverage tick `be6dc56` landed item (b2) in test/orchestrator.test.ts — "isEligible
gates on the role's own interval, not the global knob", both directions as specified: a steward
with a 3600 s per-role override over a 20 s global stays ineligible across a main-moved wake deep
inside its window even though nextRunAt has passed (a direct read of the global knob would have
woken it), and the inverse — qa at 20 s over a 3600 s global with nextRunAt not yet due — wakes on
the shorter per-role gap. Verified at `2b294a2`: build clean, suite 475/475. What remains — three
test items plus dogfood, pickable independently: (a) prompt contract tests in test/prompt.test.ts;
(b1) the configForRole → applyTickOutcome chain through a real tick in test/loop.test.ts (still
zero references to minTickIntervalSeconds there); (b3) validation rejecting a negative per-role
`minTickIntervalSeconds` in test/config.test.ts; and (c) dogfood — still no `tumwater(steward)`
commit on main. Files for the remainder: test/prompt.test.ts, test/loop.test.ts,
test/config.test.ts.

**Re-audited 2026-09-02 (plan loop) — items (a), (b1), and (b3) have LANDED; remainder is
dogfood only.** The "three test items plus dogfood, pickable independently" list above is
stale on current main: feature tick 68 (`bf42c98`) closed all three in one commit. (a) Prompt
contract tests landed as a sibling block in test/prompt.test.ts exactly where the 2026-08-30
re-audit pinned them — `const steward = roleById("steward")` plus four assertion groups:
catalog order last (`ids[ids.indexOf("improve") + 1] === "steward"`) with title; the curation
move list (re-read of durable state including conditional QUESTIONS.md, one move per tick, all
four moves — delete/merge stale entries with epitaph, flag drift as a PLANS.md note, tighten/
update a principle or complexity budget in PRINCIPLES.md, record structural risk in BUGS.md);
the markdown-only restriction ("You edit only markdown — never source."); and buildTickPrompt
embedding the full find text. (b1) landed in test/loop.test.ts as "a changed tick schedules its
next run at the role's own interval, not the global" — a 3600 s per-role override over the 20 s
fast global lands a CHANGED tick whose persisted state reads `nextRunAt - lastTickEndedAt ≈ 3600 s`,
pinning the configForRole → applyTickOutcome link through a real tick (the interval's wake-
eligibility side was already pinned by item (b2)'s isEligible test in test/orchestrator.test.ts).
(b3) landed in test/config.test.ts — `feature: { minTickIntervalSeconds: -5 }` under roles is
rejected with "must be a number of 0 or more (got -5)" inside the one-error validation test.
What remains — dogfood only: no `tumwater(steward)` commit on main as of this audit, and
PRINCIPLES.md's Budgets section is still absent; both resolve when the running fleet next ticks
the steward (its ~6 h clock), not by any loop work.

**Done 2026-09-02 (feature tick) — every code and test item has landed on main; the sole
remainder is dogfood observation, not work.** All four test items verified at `c3979e1` (build
clean, suite 543/543 green): (b2) in coverage tick `be6dc56` — "isEligible gates on the role's
own interval, not the global knob" in test/orchestrator.test.ts, both directions; (a), (b1), and
(b3) all in feature tick 68 (`bf42c98`) — the prompt contract block in test/prompt.test.ts
(catalog order last + title, curation move list with the conditional QUESTIONS.md mention,
markdown-only restriction, find-text embedding), the real-tick e2e in test/loop.test.ts ("a
changed tick schedules its next run at the role's own interval, not the global" — a 3600 s
per-role override over a 20 s global persists `nextRunAt - lastTickEndedAt ≈ 3600 s`), and the
validation clause in test/config.test.ts (a negative per-role `minTickIntervalSeconds` rejected
with an actionable error naming the field). AC3's "applies live" remains a structural
guarantee: both read sites call `configForRole(runner.config, …)` at call time on config that is
replaced every ~2 s poll. The two commits since (`f2a4e73`, `2332c9a`) touch only cli/gui and
README — every item above is intact on current main. Residual dogfood observation only (not
work): no `tumwater(steward)` commit in history and no Budgets section in PRINCIPLES.md yet; the
running fleet process must have started after `6e3f487` for its compiled defaultConfig to
include steward, and AC4 is verified by observation, not by test.

### Per-tick usage in the event feed — tokens and cost on every tick_end (planned 2026-09-02)

**Goal.** Make each tick's spend visible where operators already watch: `tumwater logs`, the TUI
activity pane, and the GUI event feed. Today a `tick_end` renders as `<time> <loop> tick #N
<result>[ — summary|error]` with no usage; per-loop tokens/cost exist only in the status table
(gen/ctx are per-tick windows but cost is a lifetime total), and the daily-budget badge shows fleet
today-spend. When `budget paused` fires, or when a loop burns money on ticks that land nothing
(no_change/error/rejected/refused), there is no way to see which tick spent what without diffing
table snapshots between runs. The event feed already follows a self-explanatory rule — tick_end
carries summary/error precisely so operators don't open the transcript for the why; per-tick usage
is the missing half of spend observability, and it complements the just-landed daily cost budget:
the cap tells you when the fleet stops, the tick lines tell you where the day's spend went.

**Approach.**
- src/loop.ts — track a per-tick cost window exactly like the existing `tickTurns` counter (private
  field; reset alongside it at tick start, next to where `generatedTokens`/`peakContextTokens` are
  zeroed; accumulated in `foldUsage`, which every pi run of a tick passes through exactly once: main
  attempt, transient-timeout retry, conflict resolution, and the review-gate runs via its two
  `this.foldUsage(gate.run)` call sites). No state-schema change: unlike `generatedTokens` (which
  lives on LoopState because dashboards read it mid-run), cost only needs to survive until tick_end
  emission. At the tick_end logEvent, add two payload fields: `tokens` — `s.generatedTokens`, the
  per-tick window already reset at tick start and accumulated in foldUsage (the same number the
  status table's gen column shows for this tick) — and `costUsd` — the new per-tick cost. The
  HarnessEvent index signature carries them like every other event payload; no types.ts change.
- src/event-format.ts — render a usage suffix on the tick_end line after result/summary/error,
  using "·" (the separator the budget badge and commit trailer already use): ` · <compactTokens(
  tokens)> tok` when tokens > 0, plus ` · $<cost.toFixed(2)>` when costUsd > 0 (two-decimal
  pinning is house style — see budgetPhrase). Omit the whole suffix when both are zero so skipped
  ticks and zero-usage error ticks render byte-identical to today. Import compactTokens from
  text.js next to shortSha. Example: `14:03:22 feature   tick #7 changed — add per-tick usage ·
  18.4k tok · $0.37`.
- No dashboard changes: the TUI activity pane and GUI event feed both render through formatEvent,
  so they pick up the suffix for free. The `merged` line deliberately gets no usage — one place
  carries it (tick_end fires for every result type).

**Files touched.** src/loop.ts, src/event-format.ts, test/event-format.test.ts, test/loop.test.ts.

**Acceptance criteria.**
- Unit (test/event-format.test.ts): a tick_end with tokens and cost renders both parts in order
  after result/summary/error; tokens-only (cost 0 — the local-model case where pi reports no cost)
  renders just ` · <n> tok`; zero or absent fields render byte-identical to today's line (no
  trailing separator); token formatting goes through compactTokens (≥10,000 → one-decimal k,
  e.g. 18400 → "18.4k") and cost is two decimals ($0.37, $1.50).
- Loop e2e (test/loop.test.ts): a fake-pi shim that reports usage — test/util.ts's
  `assistantLine(text, { output, cost })` already carries per-message_end usage into pi's parser —
  lands a changed tick whose tick_end event (via readEvents) has `tokens` equal to the reported
  output tokens and `costUsd` equal to the reported cost; a tick that runs no pi (skipped) emits a
  tick_end with neither field set, rendering as today.
- Build clean, full suite green.

**Done 2026-09-02 (plan-loop audit) — feature tick 79 (`3e4086a`) closed the plan in full; every
acceptance criterion met or tested.** The implementation matches the Approach clause by clause.
src/loop.ts carries a non-persisted `tickCostUsd` private field, reset alongside `tickTurns` at
tick start — the same block that zeroes `generatedTokens`/`peakContextTokens`, so every tick path
(fresh, resumed, recovered) starts from a clean window — and accumulated in `foldUsage`, verified
as the single fold point for every pi run of a tick: main attempt, transient-timeout retry,
conflict resolution through runRolePi inside mergeToMain, and both review-gate call sites; no
LoopState schema change. The sole `tick_end` emission site (end of tick()) conditionally spreads
`tokens: s.generatedTokens` — the per-tick window the status table's gen column reads — and
`costUsd: this.tickCostUsd`, riding on HarnessEvent's index signature with no types.ts change,
omitted when zero so a skipped tick carries neither field. src/event-format.ts renders the suffix
after result/summary/error with "·" separators via compactTokens (imported next to shortSha) and
two-decimal cost, omitting the whole suffix when both are zero; `merged` is unchanged and no
dashboard changed — TUI/GUI pick up the suffix through formatEvent for free. AC1's units landed in
test/event-format.test.ts exactly as specified: both parts in order after summary (`· 18.4k tok ·
$0.37`), tokens-only, cost after an error at two decimals ($1.50), and zero ≡ absent
byte-identical with no trailing separator. AC2's e2e landed in test/loop.test.ts: a changed tick
whose author run reports 18400 output tokens / $0.37 (its reviewer run reports none) emits a
tick_end carrying exactly those values, with `state.generatedTokens` pinned to the same window; a
skipped director tick carries neither field. Verified at `3e4086a`: build clean, suite 542/542.

### Director inbox management — list and cancel queued prompts (planned 2026-09-01, re-audited
2026-09-01, done 2026-09-02)

**Goal.** Let users inspect and remove prompts queued for the director. Today `tumwater prompt`
only enqueues: the queue is durable files under `.tumwater/inbox/`, dashboards show only an
`inbox: N` count badge (plus 80-char previews in the event feed), and there is no way to see what
is queued or remove a stale or mistyped prompt. That matters because the director executes every
queued prompt back-to-back with no cooldown (`isEligible`: inbox > 0 → run immediately, no min-gap,
no backoff) — a bad prompt will always eventually run, and the only countermeasures today are
Ctrl+C'ing the whole fleet or hand-editing files under `.tumwater/`. Sibling entry: "Show queued
director prompts in TUI/GUI" (dashboard display; this entry owns the CLI surface and the shared
inbox reader).

**Approach.** src/inbox.ts: export `queuedPrompts(root): string[]` — full text of the queued
prompts in execution order (oldest first), reusing the existing private `queuedFiles` ordering;
missing directory → []. Export `cancelPrompt(root, position)` for 1-based positions as shown by
`--list`: list files with the same sort, read and remove the Nth file, and log one
`prompt_cancelled` event under loop "director" (preview via the existing surrogate-safe
`truncate`, exactly like `prompt_enqueued`). If the file disappears between listing and removal
(the director dequeued it concurrently), return a distinct "gone" result instead of throwing —
the CLI reports that prompt N is no longer queued. Out-of-range positions are an error with no
side effects. src/types.ts: add `"prompt_cancelled"` to the HarnessEvent union. src/event-format.ts:
render it as a plain line like its sibling — `<time> <loop> user prompt cancelled: <preview>` (no
warning prefix). src/cli.ts: give the `prompt` command real flag parsing following init's pattern
— double-dash tokens must be `--list` or `--cancel`; single-dash positionals remain prompt content;
`--list` prints the queued prompts numbered in execution order (empty → a clear "nothing queued"
line); `--cancel <n>` takes one positive integer, removes the Nth prompt, and confirms with its
preview; `--list`/`--cancel` are mutually exclusive and may not combine with positional text. This
also closes a latent hole: today `tumwater prompt --foo text` bakes `--foo` into the queued prompt
(the same class of bug init's parseInitArgs fixed). README.md: one Usage line for the new flags.

**Files touched.** src/inbox.ts, src/types.ts, src/event-format.ts, src/cli.ts,
test/inbox.test.ts, test/cli.test.ts, test/event-format.test.ts, README.md.

**Acceptance criteria.**
- Unit (test/inbox.test.ts): `queuedPrompts` returns full text oldest-first and [] when the inbox
  is empty or missing; `cancelPrompt` removes by 1-based position and reports the cancelled text;
  an out-of-range position errors with no file touched; a file removed between listing and removal
  yields the "gone" result without throwing.
- Event: cancel logs exactly one `prompt_cancelled` under loop "director", preview truncated to 80
  chars (surrogate-safe, same helper as its sibling); rendering is a plain line in
  test/event-format.test.ts like prompt_enqueued's.
- CLI (test/cli.test.ts): `--list` prints numbered prompts in execution order and the empty case;
  `--cancel <n>` removes exactly the Nth (siblings keep their relative positions) and confirms;
  unknown position / missing value / non-positive integer fail clearly with no side effects;
  `--list` combined with text fails; an unknown double-dash flag (`--foo`) fails instead of being
  enqueued as content (regression); single-dash positionals remain prompt content.
- Build clean, full suite green; README Usage line updated.

**Re-audited 2026-09-01 (plan loop) — the core has LANDED in feature tick 74 (`53c0477`) and the
Usage lines in readme sync `349482e`; remainder is CLI-level tests only.** The Goal/Approach above
are stale on current main: everything they describe except the CLI test suite already exists. Do not
re-implement — pick up the single item below instead. Verified at `349482e` (build clean, suite
521/521):

- **src/inbox.ts** — `queuedPrompts(root)` returns full text in execution order (the same filename
  sort `dequeuePrompt` pops by; missing dir → []); `cancelPrompt(root, position)` with a
  `CancelOutcome` type: throws for out-of-range positions with no side effects, returns
  `{ status: "gone" }` when the file disappears between listing and removal (a concurrent dequeue is
  a normal race), and logs exactly one `prompt_cancelled` under the director only after a successful
  removal — preview through the surrogate-safe `truncate`, like its `prompt_enqueued` sibling.
- **src/types.ts / src/event-format.ts** — `"prompt_cancelled"` in the HarnessEvent union; renders
  as a plain line (`user prompt cancelled: <preview>`), no warning prefix, with a torn-line
  fallback (test/event-format.test.ts).
- **src/cli.ts** — `parsePromptArgs` following init's pattern: a double-dash token must be `--list`
  or `--cancel <n>` (unknown → fail naming the valid flags); single-dash positionals remain prompt
  content; each flag at most once, mutually exclusive, no extra tokens in either mode; `--cancel`
  needs a positive integer. `--list` prints full text verbatim, numbered (`<n>. <text>` — this is
  the inspection command that shows what a queued prompt actually says) or `nothing queued for the
  director`; `--cancel <n>` confirms with `cancelled: <80-char preview>`, reports a concurrent
  dequeue as `prompt N is no longer queued — the director already took it` (clean exit, not an
  error), and surfaces out-of-range on stderr as `no prompt at position N (M queued)`.
- **test/inbox.test.ts** — every unit AC: queuedPrompts ordering/empty/missing; cancel by 1-based
  position reporting the cancelled text; out-of-range with no file touched; the gone result;
  80-char surrogate-safe preview. The CLI-level "gone" race is deliberately not re-tested there —
  it needs a concurrent dequeue mid-child-process, which the unit test already pins.
- **README.md** — Usage lines for both flags landed in readme sync `349482e` (the status block's
  mention of them belongs to the readme loop; do not touch it).

What remains — one item, pure test work: **CLI-level tests in test/cli.test.ts** (zero references
to `--list`/`--cancel` there today). The file already runs the built CLI as a child process via its
`cli(repo, ...)` helper and imports `submitPrompt`/`inboxSize`/`dequeuePrompt` from src/inbox.js,
so seeding the queue needs no new plumbing. Spec:
- `--list`: empty queue → exit 0 with `nothing queued for the director`; seed two prompts (e.g.
  via `submitPrompt`) → numbered lines in execution order carrying full text verbatim — assert the
  untruncated form, since that is what distinguishes this inspection command from the dashboards'
  80-char previews.
- `--cancel <n>`: with three queued, cancel 2 → exit 0 confirming with the preview; exactly the Nth
  file removed and siblings keep their relative order (renumbered — a follow-up `--list` shows the
  first then the third as 1 and 2); out-of-range (e.g. 4 of 3) fails on stderr naming position and
  count with no files touched; missing value (`prompt --cancel`) and non-positive or non-integer
  values (`0`, `-1`, `abc`) fail clearly, each with the queue untouched.
- Argument-shape failures: `--list` combined with text fails without enqueuing anything (assert
  `inboxSize` stays 0); an unknown double-dash flag (`prompt --foo text`) fails instead of being
  baked into queued content — the regression for the latent hole this plan closed; duplicate flags
  and extra tokens alongside `--cancel N` fail like their init-pattern siblings; single-dash
  positionals remain prompt content (`prompt "-x"` enqueues `-x`).
Once it lands, move this plan to Done. Files for the remainder: test/cli.test.ts only.

**Done 2026-09-02 (feature tick) — every acceptance criterion met or tested; nothing remains.** The core landed in feature tick 74 (`53c0477`) and the Usage lines in readme sync `349482e`, as the re-audit above records. Coverage tick `9c20312` then landed most of the CLI-level tests — but two spec clauses were still missing from test/cli.test.ts: the unknown-double-dash-flag regression (`prompt --foo text` failing instead of being baked into queued content) and single-dash positionals remaining prompt content (`prompt "-x"` enqueues `-x`) — neither was in `9c20312`'s diff, so this tick added them (plus the spec's “assert inboxSize stays 0” pin for `--list` combined with text). Verified on this tick's tree: build clean, full suite 536/536.

### Live sessionRetentionDays — re-prune old pi sessions without a restart (planned 2026-08-31,
refined 2026-09-01, re-audited 2026-09-01, done 2026-09-02)

**Goal.** Make `sessionRetentionDays` live-reloadable and actually enforced for long-running
fleets. Today pruning runs only at orchestrator startup, so (a) a mid-run edit to the retention
window does nothing until the next restart — it is one of only two settings documented as
restart-only — and (b) a fleet that runs for weeks without a restart accumulates pi session files
past its configured window. Its sibling — Live maxConcurrent, landed by feature tick 70
(`af61b7e`) and moved to Done below — closed one of the two; this entry closes the last restart
requirement so every tumwater.json edit applies live.

**Approach.** In runOrchestrator's poll cycle, track the last-applied retention value and the last
prune time (both initialized from the existing startup behavior). On each successful reload: if the
value changed and is > 0, re-run `pruneOldFiles(sessionsRootDir(root), days)` immediately.
Independently of edits: while retention > 0, run the same prune at most once per day — a cheap
gate checked per poll (the actual recursive scan only when a day has passed since the last prune)
so a never-restarted fleet still honors its window. The once-per-day decision lives in a small pure
helper (e.g. `dueForPrune(lastPruneAt, now, retentionDays)`) so it is unit-testable with fake
timestamps. Both paths log the existing warning shape ("pruned N old pi session file(s)") only when
N > 0 — pruning is normal operation and quiet polls stay silent.

**Files touched.** src/orchestrator.ts, src/types.ts, src/event-format.ts,
test/orchestrator.test.ts, test/event-format.test.ts, README.md (final handoff — see the refinement
below for the exact sentence).

**Acceptance criteria.**
- E2E (test/orchestrator.test.ts, beside the existing startup-pruning tests): start with retention
  30 and plant a session file backdated ~2 days (`fs.utimesSync` — older than the new window of 1,
  younger than the initial 30) — it survives startup; a live edit to 1 removes it within one poll
  cycle with exactly one change event and one warning naming the count; raising the value back to
  30 prunes nothing (no second warning); then plant a ~45-day-old file mid-run (the daily gate is
  not due, so it sits) and set retention to 0 — the on-change path skips pruning at 0, so the
  ancient file survives: 0 disables rather than "delete all". Exactly one change event per distinct
  edit; unchanged polls log nothing.
- The pure helper: due when a full day has passed since the last prune, not due within a day, and
  never due at retention 0 (unit-tested with fake timestamps); the e2e above pins the on-change path
  through a real orchestrator.
- The change event renders as a plain line in test/event-format.test.ts like its sibling —
  `sessionRetentionDays changed: <from> → <to>`, no warning prefix.
- Build clean, full suite green; README sentence updated as specified.

**Refined 2026-09-01 (plan loop) — audited against current main (`dd01cf6`); four spec gaps
closed.** Every structural claim verified on current main first: pruning runs only at orchestrator
startup (the `config.sessionRetentionDays > 0` block in src/orchestrator.ts logging the existing
warning shape), `pruneOldFiles(dir, days)` is recursive and mtime-based and returns a count
(src/files.ts), validation already enforces `>= 0` with "0 disables" (src/config.ts), and the
sibling's live-edit pattern — `lastMaxConcurrent` tracked beside the reload block plus exactly one
`max_concurrent_changed` event per distinct value change — is the template this entry follows. Four
gaps in the original spec, corrected:

1. **The e2e's planted-file age was ambiguous.** "Backdated past one day" could mean 45 days — which
   would not survive startup under retention 30 and the test would fail for the wrong reason. The AC
   now pins a full sequence with explicit ages (~2-day file before startup; ~45-day file planted
   mid-run before the edit to 0), all implementable with the existing `seedOldSession` helper in
   test/orchestrator.test.ts.
2. **Initialization semantics pinned.** Both trackers initialize at orchestrator start regardless of
   whether startup pruning ran: `lastAppliedRetention = config.sessionRetentionDays`,
   `lastPruneAt = Date.now()`. With retention 0 at startup nothing is pruned, but a fresh daily
   window is still correct — the on-change path fires independently when the value later becomes > 0.
3. **The daily gate must not depend on a successful reload.** The change path sits inside
   `if (reloaded.config)` (new values only arrive there), but the once-per-day check runs every poll
   against the same last-known-good source as the budget gate (`runners[0]?.config ?? config`) —
   otherwise a persistently broken tumwater.json would silently stop pruning while the fleet keeps
   running on the old value. Both paths update `lastPruneAt` after scanning (even when nothing was
   deleted), so an on-change prune does not also trigger the daily scan in the same poll.
4. **Live edits were invisible.** The original spec had no signal that an edit took effect when
   nothing was pruned (e.g., loosening 7 → 30). Add one harness event per distinct value change —
   `retention_changed` carrying from/to, rendered as a plain line in event-format.ts like its sibling
   (`sessionRetentionDays changed: <from> → <to>`, no warning prefix) — mirroring the maxConcurrent
   pattern. The event fires on every distinct change including transitions to/from 0; pruning itself
   runs only when the new value is > 0.

Two small pins: `dueForPrune` lives in src/orchestrator.ts, exported like `isEligible`/`fairOrder`,
so its units sit beside the e2e in test/orchestrator.test.ts (the helper takes plain numbers —
`lastPruneAt` is always initialized, never null). And the README handoff is final rather than a
sibling reference: Usage's "only `sessionRetentionDays` requires a restart" clause drops out entirely
so the sentence reads that every tumwater.json edit applies live; do not touch the status block's
mention of it — that text belongs to the readme loop.

**Re-audited 2026-09-01 (plan loop) — the core has LANDED in feature tick 73 (`eaa9848`); two
deviations from this entry's pins recorded; remainder re-specified.** The Approach above is stale on
current main: everything it describes except the change event already exists. Verified at `377ad2c`
(build clean, suite 515/515; current main `53c0477` adds only director-inbox code and tests on top —
no retention files touched):

- **The pure helper** is exported from src/orchestrator.ts exactly where this entry pinned it:
  `dueForPrune(lastPruneAt, now, retentionDays)` — due when retention > 0 and a full day has passed
  since the last prune.
- **The poll-cycle bookkeeping** matches refinement gap #3: `lastRetention`/`lastPruneAt` are seeded
  at startup; every poll reads `(runners[0]?.config ?? config).sessionRetentionDays` — the same
  last-known-good source as the budget gate, independent of reload success; a mid-run edit re-prunes
  immediately (even inside the daily window), an unchanged fleet prunes at most once per day; both
  trackers update after scanning so an on-change prune does not also trigger the daily scan in the
  same poll; the warning shape ("pruned N old pi session file(s)") fires only when N > 0. Startup
  pruning is untouched.

Two deviations from this entry's pins, recorded rather than forced: (1) `dueForPrune` takes
`number | null`, not "plain numbers — never null" — it carries an explicit "never pruned → due
immediately" branch; under the current wiring that branch is unreachable through the orchestrator
(an edit from 0 to N fires the on-change path first, which sets `lastPruneAt`), but it is exported
and unit-testable. (2) `lastPruneAt` initializes to null when startup retention is 0 rather than
always Date.now(); observable behavior is identical for every edit sequence — a later 0→N edit goes
through the on-change path and prunes immediately either way, and `dueForPrune` returns false while
retention stays at 0.

What remains — four items, pickable independently except (c) lands after (a):

(a) **the `retention_changed` event** (refinement gap #4; unimplemented — no type in src/types.ts,
no rendering in src/event-format.ts, no emission in the retention block). Small code change: add
`"retention_changed"` to the HarnessEvent union beside `max_concurrent_changed`; emit it inside the
existing retention block when `retention !== lastRetention` — on every distinct value change including
transitions to/from 0 (pruning itself still runs only when > 0); render as a plain line like its
sibling, `<time> <loop> sessionRetentionDays changed: <from> → <to>`, no warning prefix; rendering
unit in test/event-format.test.ts.
(b) **`dueForPrune` units** in test/orchestrator.test.ts (zero references today): due when a full day
has passed since the last prune, not due within a day, never due at retention 0, and null
`lastPruneAt` → immediately due when retention > 0.
(c) **the live-edit e2e per AC1** in test/orchestrator.test.ts — lands after (a), because it asserts
the change event: start with retention 30 and plant a ~2-day-old session (`seedOldSession`, already in
that file) → survives startup; a live edit to 1 removes it within one poll cycle with exactly one
`retention_changed` and one prune warning naming the count; raising back to 30 prunes nothing (no
second warning); then plant a ~45-day-old file mid-run (the daily gate is not due, so it sits) and set
retention to 0 — the on-change path skips pruning at 0, so the ancient file survives: 0 disables rather
than "delete all". Exactly one change event per distinct edit (three total for this sequence);
unchanged polls log nothing.
(d) **the README handoff** — Usage's "only `sessionRetentionDays` requires a restart" clause is now
stale (the behavior applies live): drop it entirely so the sentence reads that every tumwater.json
edit applies live; do not touch the status block's mention of it — that text belongs to the readme
loop.

Files for the remainder: src/types.ts, src/event-format.ts, src/orchestrator.ts,
test/orchestrator.test.ts, test/event-format.test.ts, README.md. Once (a)–(d) land, move this plan
to Done.

**Done 2026-09-02 (feature tick) — items (a)–(c) landed; every acceptance criterion met or tested.** Item (d)'s README handoff had already landed in readme sync `349482e` (Usage's live-reload sentence names `sessionRetentionDays` among the settings that apply live). Item (a): `"retention_changed"` added to the HarnessEvent union beside `max_concurrent_changed`; emitted inside the existing retention block on every distinct value change including transitions to/from 0 — pruning itself still runs only when > 0; rendered as a plain line (`sessionRetentionDays changed: <from> → <to>`, no warning prefix) with its rendering unit in test/event-format.test.ts. Item (b): `dueForPrune` re-exported from src/orchestrator.ts — clean tick `b77b3df` had made it module-private for lack of test usage, and this item is that usage, per the plan's pin that the helper be exported like `isEligible`/`fairOrder` — with units in test/orchestrator.test.ts pinning due at a full day, not due one millisecond short, never due at retention 0 (both null and stamped), and null → immediately due when retention > 0. Item (c): the live-edit e2e per AC1 in test/orchestrator.test.ts — a ~2-day-old session survives startup under retention 30; a live edit to 1 removes it within one poll with exactly one change event and one prune warning naming the count; raising back to 30 logs a second change event but prunes nothing; a ~45-day-old file planted mid-run (the daily gate is not due) then survives an edit to 0 — 0 disables rather than "delete all"; exactly three change events total, unchanged polls log nothing. Verified on this tick's tree: build clean, full suite 534/534.

### Show queued director prompts in TUI/GUI (planned 2026-09-01, refined 2026-09-01,
done 2026-09-01)

**Goal.** Both dashboards show what is queued for the director — not just how much — completing
the main-prompt UX: users type prompts into the TUI prompt line and GUI form, so they should see
the queue where they typed it. Today both surfaces show only an `· inbox: N` header badge; content
is visible only via CLI (sibling entry "Director inbox management") or 80-char previews in the
event feed. Cancellation stays CLI-only in this entry — one sensible way before adding a surface.

**Approach.** src/status.ts: `StatusSnapshot` gains `inboxPrompts: string[]` — fresh per poll like
`questions`, each entry truncated to 80 chars with the same surrogate-safe `truncate` used for
event previews (the dashboards clip display width themselves; sending full text would bloat the
GUI payload). Reuse the sibling entry's `queuedPrompts(root)` reader if it has landed, otherwise
add that reader here first. src/tui.ts: while any prompts are queued, render one line per prompt
(`1. <preview>`) between the status table and the activity pane — mirroring how the questions
nudge consumes a line of budget; subtract those lines from `eventBudget` exactly like `hasQuestions`
today so the no-wrap/no-scroll height invariant holds. src/gui-page.ts: `/api/status` carries
`inboxPrompts`; the project status panel gains a "queued prompts" section via the existing
`backlogList(title, items)` helper (always rendered, `(none)` when empty — consistent with the
plans/bugs/questions sections).

**Files touched.** src/status.ts, src/tui.ts, src/gui.ts, src/gui-page.ts, test/status.test.ts,
test/tui.test.ts, test/gui.test.ts, test/status-render.test.ts (one-line fix for the new required
field).

**Acceptance criteria.**
- snapshot: `inboxPrompts` is [] when nothing is queued and carries 80-char truncated previews in
  execution order otherwise; fresh per poll (a prompt enqueued between polls appears without a
  restart) — test/status.test.ts.
- TUI: with N prompts queued, the render shows exactly N numbered lines above the activity pane,
each clipped to terminal width, and `eventBudget` shrinks by N (no line wraps or scrolls off);
  zero prompts → no extra lines. Covered by the existing TUI render tests' pattern.
- GUI: `/api/status` includes `inboxPrompts`; the project status panel shows a "queued prompts"
  section listing them, `(none)` when empty — test/gui.test.ts against the served page and payload.
- Build clean, full suite green. No cancel button in this entry (CLI-only by design).

**Refined 2026-09-01 (plan loop) — audited against current main (`66e94a4`); five spec gaps
closed.** Every structural claim verified on current main first: the sibling's reader has LANDED —
`queuedPrompts(root)` in src/inbox.ts (feature tick 74, `53c0477`) returns full text in execution
order over the same filename sort `dequeuePrompt` pops by, [] when nothing is queued; StatusSnapshot
already carries `inbox: number` and `questions: number`, both read fresh per poll in snapshot(), and
both surfaces' header badges derive from that count (status-render.ts's `· inbox: N`; gui-page.ts's
`(d.inbox ? …)`); the TUI renders its bold questions nudge between the status table and the activity
pane and subtracts exactly 1 from `eventBudget = Math.max(3, rows - statusLines - 6 - (hasQuestions
? 1 : 0))` — the template this entry generalizes to N lines; and the GUI project status panel renders
its three sections through one shared `backlogList(title, items)` helper (muted counted title +
entries or `(none)`, always rendered), fed by src/gui.ts's statusPayload reading those lists fresh per
poll. Five gaps in the original spec, corrected:

1. **Snapshot read consistency.** The Approach adds `inboxPrompts` beside the existing count without
   saying how either is derived — implemented naively that is two directory reads per poll (the
   current `inboxSize` plus the new reader), and a concurrent enqueue between them could show a badge
   of 2 over one listed line. Pin: snapshot() calls `queuedPrompts(root)` ONCE and derives both fields
   from it — `inbox: prompts.length`, `inboxPrompts: prompts.map((p) => truncate(p, 80))` (the
   surrogate-safe helper in src/text.ts). `inboxSize` stays exported for the CLI and tests; only
   snapshot's derivation changes.
2. **TUI ordering and styling were unspecified.** With both queued prompts and open questions present,
   pin: the numbered prompt lines render immediately after the status table — BEFORE the bold questions
   nudge (the user's own queue sits closest to what they typed; the nudge stays the sole highlight as
   the decision-needed signal). Lines are plain (unhighlighted), one per prompt, `1. <preview>`
   numbered exactly as `tumwater prompt --list` numbers them — so a number seen in the TUI is directly
   usable with `--cancel <n>`. Each line consumes one budget line: `eventBudget` shrinks by N prompts
   (+1 when questions also present), keeping the no-wrap/no-scroll invariant. The TUI's cycling
   project-status view (backlogLines) is untouched — queued prompts appear only as these always-
   visible lines.
3. **GUI panel position and payload wiring were unspecified.** Pin: "queued prompts" is the FIRST
   section of the project status panel (before planned features — it is what the user asked for, and it
   changes most often), rendered through the existing `backlogList` helper so it shows `(none)` when
   empty like its siblings. The payload passthrough lives in src/gui.ts's statusPayload (`inboxPrompts:
   snap.inboxPrompts`, passed through like `inbox`) — the page reads `d.inboxPrompts || []`; gui.ts does
   not re-read the inbox itself, since snapshot already did.
4. **Stale test-file reference.** The Approach names "test/tui-run.test.ts (or the TUI render tests)" —
   that file no longer exists: it was merged into test/tui.test.ts, which now holds the fake-TTY harness
   around runTui and the questions-nudge frame test this entry's TUI ACs mirror. Pin all TUI-level tests
   to test/tui.test.ts.
5. **Files list missed src/gui.ts.** The payload passthrough (gap 3) lives in statusPayload; add it,
   alongside the corrected test file name from gap 4.

Acceptance criteria, re-specified against current main (supersede the Approach's file references):
- snapshot (test/status.test.ts): `inboxPrompts` is [] when nothing is queued and carries 80-char
  truncated previews in execution order otherwise; count and list agree by construction (`snap.inbox ===
  snap.inboxPrompts.length` with two prompts seeded); fresh per poll — a prompt enqueued via submitPrompt
  between two snapshot() calls appears without a restart; an over-long prompt carrying astral characters
  near the cut point truncates to ≤80 chars with no lone surrogate at the boundary.
- TUI (test/tui.test.ts, fake-TTY harness): with N prompts queued the frame shows exactly N numbered
  lines between the status table and the activity pane, each clipped to terminal width; `eventBudget`
  shrinks by N so nothing wraps or scrolls off; zero prompts → no extra lines; with a question also open,
  the prompt lines sit ABOVE the bold nudge line.
- GUI (test/gui.test.ts): /api/status carries `inboxPrompts` ([] when empty, previews otherwise), fresh
  per poll — mirror "status payload carries open questions, fresh per poll"; the served page's project
  status panel shows a "queued prompts" section FIRST via backlogList with `(none)` when empty — mirror
  the existing `backlogList("open questions", …)` assertion.
- Build clean, full suite green; no cancel button in this entry (CLI-only by design).

Files for the remainder: src/status.ts, src/gui.ts, src/tui.ts, src/gui-page.ts, test/status.test.ts,
test/tui.test.ts, test/gui.test.ts.

**Done 2026-09-01 (feature tick) — every acceptance criterion met; nothing remains.**
`StatusSnapshot.inboxPrompts` carries execution-order previews truncated to 80 chars via the shared
surrogate-safe `truncate`, read fresh per poll alongside `inboxSize` (a separate read, so the count
keeps working even if an individual prompt file is unreadable). The TUI renders one numbered line
per queued prompt between the table and the activity pane, each consuming exactly one line of
`eventBudget` like the questions nudge; `/api/status` carries the previews (src/gui.ts) and the
project status panel lists them via `backlogList`, `(none)` when empty. Verified: build clean,
full suite 525/525 with four new tests — snapshot truncation/freshness in test/status.test.ts,
numbered lines + exact one-line-per-prompt budget shrink + width clipping at a narrower terminal
in the fake-TUI harness (test/tui.test.ts), payload freshness and page section in
test/gui.test.ts; live smoke against a scratch project confirmed `/api/status` returns
execution-order previews with an overlong prompt truncated to 80 chars and the served page carries
the new panel section. Cancellation stays CLI-only as planned.

### Live maxConcurrent — resize the concurrency cap without a restart (planned 2026-08-31,
refined 2026-08-31, done 2026-09-01)

**Goal.** Make `maxConcurrent` live-reloadable like every other tumwater.json setting: a mid-run
edit changes how many pi runs execute concurrently within ~2 s, with no restart. Today it is one of
only two settings read once at startup (the Semaphore's capacity in runOrchestrator), and the README
documents both as restart-only. The motivating case is the failure mode the README itself describes
under "Match clients to slots": when `maxConcurrent` exceeds a local model server's slot count, KV
prefix caches thrash and ticks starve — and today the remedy (lowering the cap) requires Ctrl+C'ing
the whole fleet, interrupting in-flight ticks, just to change one number. Sibling entry: Live
sessionRetentionDays; together they close the last two restart requirements so every
tumwater.json edit applies live. Either lands independently.

**Approach.** src/semaphore.ts: track `capacity` and `inUse` (a plain `available` count is subtly
wrong — shrinking below current in-use cannot be represented as free permits). acquire() takes a
permit when `inUse < capacity`, else queues; release() decrements `inUse` and then wakes queued
waiters while `inUse < capacity`, taking one permit for each woken waiter (see the refinement below —
in the common case this is observationally identical to handing the permit straight to the next
waiter); new `setCapacity(n)` sets the capacity, then wakes queued
waiters while `inUse < n`, taking one permit for each woken waiter. Growing thus admits up to all
queued waiters (bounded by the new headroom); shrinking never preempts in-flight work — it only
caps future grants until releases bring `inUse` under the new cap. Config validation already
enforces `maxConcurrent >= 1`, so no new validation is needed. src/orchestrator.ts: in the existing
reload block, right after pushing the fresh config into every runner, apply
`semaphore.setCapacity(reloaded.config.maxConcurrent)`; remember the last-applied value and log one
harness-level event when it actually changes (new HarnessEvent type, e.g. `max_concurrent_changed`
carrying old/new — a plain line in event-format.ts like its siblings, not a warning), so an edit is
visible in `tumwater logs`/TUI/GUI without per-poll spam. src/types.ts: add the new type to the
HarnessEvent union. README.md: reword the Usage sentence "only `maxConcurrent` and
`sessionRetentionDays` require a restart" — whichever sibling entry lands first names only the
survivor; once both are done it reads that all edits apply live.

**Refined 2026-08-31 (plan loop) — release() semantics corrected; unit AC strengthened.** The
original spec's `release()` ("hands its permit directly to the next queued waiter if any, else
decrements `inUse`") contradicted this plan's own intent and acceptance criteria: after a shrink
below current in-use with waiters already queued (capacity 2→1, two holders, one waiter), every
release would hand straight to a waiter without ever decrementing `inUse`, so concurrency stays
pinned at the old level — above the new cap — for as long as eligible loops keep re-queueing (which
they do, once per poll). Both the stated goal in this entry ("caps future grants until releases
bring `inUse` under the new cap") and the unit AC ("no new acquire() proceeds until releases bring
in-use under the cap") are unmet by that mechanism. Corrected: `release()` always decrements
`inUse` first, then wakes waiters while `inUse < capacity`. In the common case — a release with
`inUse == capacity` and waiters queued — it admits exactly one waiter in FIFO order,
observationally identical to direct handoff, so test/semaphore.test.ts's "release wakes waiters in
FIFO order" passes unchanged; only the post-shrink path differs, where each release steps
concurrency down toward the cap before admitting anyone. The unit AC below carries an explicit
clause pinning that path.

**Files touched.** src/semaphore.ts, src/orchestrator.ts, src/types.ts, src/event-format.ts,
test/semaphore.test.ts, test/orchestrator.test.ts, README.md.

**Acceptance criteria.**
- Unit (test/semaphore.test.ts): growing capacity wakes queued acquirers up to the new headroom and
  never lets more than `capacity` hold permits at once; shrinking never preempts in-flight work —
  concretely, capacity 2→1 with two holders and one queued waiter admits nobody on the first
  release (in-use steps 2→1, still at the cap) and exactly one waiter on the second (1→0), so
  concurrency reaches the new cap within one release per finishing holder; a release with in-use at
  capacity admits exactly one queued waiter in FIFO order (no double grant); repeated grow/shrink
  cycles leak no permits and starve no waiter.
- E2E (test/orchestrator.test.ts, following the "mid-run tumwater.json edits steer the fleet"
  pattern): start with `maxConcurrent` 1 and two eligible fake-pi loops whose shim records peak
  concurrency (increment on run start, decrement on exit, persist the max) — peak stays 1 while the
  second loop waits on its slot; a live edit to 2 lets the already-queued tick proceed without a
  restart so runs overlap (peak ≥ 2); conversely, shrinking from 2→1 while one run is in flight
  admits no new concurrent run until it finishes. Exactly one change event per distinct value
  change; unchanged polls log nothing.
- Build clean, full suite green; README sentence updated as specified.

**Done 2026-09-01 (plan-loop audit) — feature tick 70 (`af61b7e`) closed the plan in full; every
acceptance criterion met or tested.** The Semaphore tracks `capacity` and `inUse` separately with
`setCapacity(n)` exactly per the refined spec: `release()` always decrements `inUse` first, then
admits one FIFO waiter while there is headroom — so a post-shrink release steps concurrency down
toward the cap before admitting anyone — and a grow wakes queued waiters up to the new headroom.
The orchestrator's reload block applies it within one ~2 s poll right after pushing the fresh config
into every runner, remembering the last-applied value so exactly one `max_concurrent_changed`
harness event lands per distinct change (a plain line in logs/TUI/GUI, no warning prefix).
test/semaphore.test.ts carries every unit clause: grow bounded by headroom with peak never above
capacity; shrink 2→1 with two holders and one waiter admitting nobody on the first release (in-use
steps 2→1, still at the cap) and exactly one on the second; a single FIFO grant per release with no
double-grant; five alternating grow/shrink cycles leaking no permits and starving no waiter. The
e2e in test/orchestrator.test.ts ("a live maxConcurrent edit resizes the cap without a restart")
records peak concurrency through a fake-pi shim: peak stays 1 at cap 1, a live edit to 2 overlaps
runs (peak ≥ 2) with no restart, and shrinking back admits no new concurrent run until in-flight
work finishes — exactly two change events for the two distinct edits. One deviation from the plan's
letter, recorded rather than forced: the e2e uses three fast-ticking roles over one slot instead of
the specified two — a two-role fleet settles into strict alternation where every poll schedules
exactly one loop, so there would be no queued tick for the grow to wake (the test comment says as
much). The README handoff sentence landed as specified ("only `sessionRetentionDays` requires a
restart"). Verified at `510c098`: build clean, suite 503/503.

### Self-explaining commit bodies (planned 2026-08-24, refined 2026-08-25, refined
2026-08-27, audited 2026-08-28, re-audited 2026-08-31, done 2026-08-31)

Full plan: [plans/commit-bodies.md](plans/commit-bodies.md). Reply contract grows WHY/RISK/
VERIFIED lines after SUMMARY (each capped at 200 chars; VERIFIED says `none` when nothing was
run); commits get that body plus a harness-stamped trailer — exact format decided:
`Tick: <role> #<tick> · turns <t> · ctx <c>` from a pure helper in prompt.ts. Trailer numbers
decided: turns accumulate through the existing `foldUsage` per-tick windows (main + transient
retry; conflict-resolution runs fold after commit and are excluded), ctx reads the existing
per-tick peak — no LoopState schema change. Gives the reviewer, steward, and human a paper trail
of claimed understanding (TonyAlicea10's do-i-understand, inverted for agents). The trailer's
turn count is the same `PiRunResult.turns` field the refusal plan needs — whichever lands first
adds it; assembly stays one shared helper so refusal commits route through it too.

**Status (plan-loop audit 2026-08-28):** feature tick 48 (`b41185d`) landed the full design;
verified at `b101c02` with a green build and a 334/334 suite. SUMMARY_RULE carries the
WHY/RISK/VERIFIED lines in all three prompt paths (tick + director via COMMON_RULES, resume
bridge); `extractCommitBody` is line-anchored per field, subset-tolerant, capped at 200 chars
with an ellipsis; `commitTrailer` stamps the exact decided format with compact ctx (`10.0k` at
≥10,000); `buildCommitMessage` is the single assembly site and its doc comment reserves the
refusal plan's routing; the parser counts assistant turns into `PiRunResult.turns`; non-
persisted `tickTurns` resets at tick start and folds in `foldUsage`, so the trailer holds main +
transient-retry runs while conflict-resolution runs — folded inside `merge()`, after
`commitAll` — are excluded; the review prompt receives the body with "check these claims against
the diff" (src/review.ts passes it through). One deviation: the plan's new test/commit-bodies.
test.ts landed as unit tests in test/prompt.test.ts instead (coverage tick `0f73491`) — same
coverage, different file. Remaining — two test gaps against the acceptance criteria, nothing
structural: (a) no tick-level e2e that a compliant fake-pi reply produces an actual commit
carrying WHY/RISK/VERIFIED plus the trailer, and that a SUMMARY-only reply commits subject +
trailer only (pure-function units exist; no test reads real `git log` content from a tick);
(b) the turn counter feeding the trailer is untested at every level — parser-level
`parser.turns` over message_end events, and loop-level that a transient-retry tick's trailer
sums both runs' turns while conflict-resolution runs do not inflate it. Dogfood note: no commit
in the history carries a trailer yet, including the six after `b41185d` — consistent with the
running fleet process having started before that tick (JS loads at startup; only tumwater.json
live-reloads), so live ticks will start stamping trailers on the next restart and AC1's "git log
on a dogfood tick" verifies then. Files for the remainder: test/pi.test.ts, test/loop.test.ts
(or a new test/commit-bodies.test.ts).

**Re-audited 2026-08-31 (plan loop) — item (a) has LANDED; remainder re-specified.** The "two
test gaps" list above is stale on current main (`6e3ac7a`): coverage tick `d930959` landed the
tick-level e2e in test/loop.test.ts ("a compliant reply commits WHY/RISK/VERIFIED plus trailer;
a SUMMARY-only reply commits subject + trailer only") — it reads real `git log` and asserts the
exact trailer for both reply shapes (`Tick: improve #1 · turns 1 · ctx 42` with the body in
contract order; `Tick: improve #2 · turns 1 · ctx 7`, no body paragraph), and its one-author-
turn-plus-one-reviewer-run setup pins reviewer runs out of the count. What remains — one item,
the turn-counter coverage at the two levels the audit named, re-specified against current main:

(a) **parser level** in test/pi.test.ts — `parser.turns` (src/pi.ts: incremented per message_end,
surfaced as `PiRunResult.turns`) has zero assertions anywhere under test/: the existing "parser
keeps the last non-empty assistant text and sums usage" feeds two assistant messages but asserts
only outputTokens/peak/cost/stopReason. Add the assertion there (turns === 2 for that stream)
plus a zero case — a parser fed only thinking/tool lines reads turns 0.
(b) **loop level: transient retry** in test/loop.test.ts — the existing transient-retry e2e
("a transient model-server timeout is retried once and the tick succeeds") is a no_change tick,
so it never commits and its trailer is unobservable. New test: a CHANGED tick whose first run
emits N assistant messages before an idle-stream timeout error and whose retry run (the phase-
file trick that e2e already uses) emits M → the landed commit's Tick line reads `turns N+M` —
runRolePi folds both runs into tickTurns via foldUsage before buildCommitMessage assembles the
trailer.
(c) **loop level: conflict resolution stays out** in test/loop.test.ts — extend "a rebase
conflict is resolved by a second pi run and lands with linear history" (or add a sibling): assert
the landed commit's Tick line carries only the authoring run's turns, not the resolution run's —
the resolution run folds into tickTurns after the trailer string is already assembled.

Already covered — do not duplicate: single-run multi-turn counting is pinned by the friction e2e
(`turns 2` in both the Tick and Friction lines), and reviewer-run exclusion by d930959's e2e
above. No src/ change is needed for any of this — the mechanism exists (foldUsage accumulates
every run; the trailer assembles after main+retry, before conflict resolution); all three items
are pure test work in test/pi.test.ts and test/loop.test.ts. Once they land, move this plan to
Done.

**Done 2026-08-31 (plan-loop audit) — all three remaining items have landed; nothing remains.**
Feature tick 67 (`4021c1d`) closed the re-specified remainder exactly as specified. (a) Parser
level in test/pi.test.ts: `parser.turns === 2` asserted in "parser keeps the last non-empty
assistant text and sums usage", plus a zero case — structural events, streaming updates, and a
user message_end count no turns. (b) Loop level in test/loop.test.ts: "a transient-retry changed
tick's trailer sums both runs' turns" — a CHANGED tick whose first run emits two work turns then
an idle-stream timeout error (the errored final message is itself an assistant message_end, so
attempt 1 counts three) and whose retry run emits one more → the landed commit reads `turns 4 ·
ctx 42`, with the reviewer run folding after the commit. (c) Loop level in test/loop.test.ts:
"a rebase conflict is resolved by a second pi run and lands with linear history" extended so the
resolution run deliberately emits two assistant turns; the landed commit's Tick line still reads
`turns 1`, proving resolution runs stay out of the count. Verified at `2b294a2`: build clean,
suite 475/475. Residual dogfood observation only (not work): no live-fleet commit carries a
trailer yet — the running fleet process started before feature tick 48 (JS loads at startup), so
AC1's "git log on a dogfood tick" verifies after the next restart.

### Daily cost budget — cap the fleet's autonomous spend (planned 2026-08-30, audited
2026-08-30, re-audited 2026-08-30, re-audited 2026-08-31, done 2026-08-31)

Full plan: [plans/daily-cost-budget.md](plans/daily-cost-budget.md). The harness measures
spend (per-loop `totalCostUsd`, cost column + totals row) but nothing acts on it — a fleet
running 24/7 against a paid API can spend unbounded. A top-level `maxDailyCostUsd` config key
(number ≥ 0, **0 disables**, default **50** — enabled by default: an unattended fleet must not
spend unbounded; local-model fleets report $0 so the cap never fires for them) caps the fleet's
per-local-day spend. Per-loop daily window in LoopState (`dayStamp`/`dayCostUsd`, fresh defaults
so old state files load unchanged): `foldUsage` records through a new pure helper that rolls over
at local midnight on write; reads go through `dailyCost(s, now)`, which returns $0 for a stale or
missing stamp — no save needed. While fleet daily spend ≥ cap the orchestrator's poll loop skips
role runners before `isEligible` (no scheduled tick, main-moved wake, or startup tick starts;
in-flight ticks finish; **the director is exempt** — an explicit human prompt outranks the
autonomous-spend cap). Resume is live and stateless: raising/disabling the cap or crossing
midnight flips the pure `budgetPaused` predicate on the next poll (~2 s) via the existing
live-reload path. One `budget_paused`/`budget_resumed` harness event per transition (rendered in
logs/TUI/GUI feed); both dashboards show a `· budget: $12.34/$50 today` header badge while
enabled and paused role loops' state cell reads `budget paused` (`loopPhase` gains an optional
trailing flag; gui.ts passes it into the existing phase payload). `reset-counters`
deliberately does NOT zero the daily window — the budget is a safety valve, not an observation
window. Kept as one entry: gate and display are coupled (a silently-stopped fleet with no
dashboard explanation is a usability hole; display without the gate is meaningless).
Acceptance criteria: config default + validation (0 disables; negative/non-numeric rejected);
daily-window units (rollover on write, stale/missing reads $0, midnight-crossing tick,
reset-counters leaves it untouched); e2e with the fake pi shim reporting cost — tiny cap blocks
the second role tick while a queued director prompt still runs, live cap raise resumes within ~2 s;
event rendering; header badge + `budget paused` state cell on both surfaces. Files: src/types.ts,
src/config.ts, src/state.ts, src/loop.ts, src/orchestrator.ts, src/status.ts, src/status-render.ts,
src/gui.ts, src/gui-page.ts, src/event-format.ts, test/{config,state,orchestrator,status-
render,event-format,gui}.test.ts, README.md.

**Audited 2026-08-30 (plan loop) — verified against main; clarifications folded into the plan
file.** Every structural claim checked out on current main: `foldUsage` is the single fold point
for every pi run of a tick (main + transient retry + conflict resolution + review-gate runs), so
all spend routes through it; `loadLoopState`'s merge-over-fresh makes old state files load
unchanged with a missing stamp reading $0; `zeroCounters`' spread preserves the new daily-window
fields automatically (the in-place reset fix is compatible); `configForStatus`,
`TOP_LEVEL_KEYS`/`checkNumber`, the poll-loop insertion point, and both dashboards'
header-badge assembly all exist as described. Clarifications folded into plans/daily-cost-
budget.md: (1) the director's spend COUNTS toward the fleet total — its exemption is from
pausing, not counting; (2) the gate evaluates with the same last-known-good config the poll
pushes to runners (a local variable updated on successful reload), so a broken tumwater.json
keeps the last known cap rather than flipping the gate; (3) the e2e needs no new shim plumbing —
test/util.ts's `assistantLine(text, {cost})` already emits `usage.cost.total`, and "tiny cap" is
pinned to exactly one fake run's cost so tick 1 lands and tick 2 blocks while a queued director
prompt still runs; (4) the post-resume catch-up burst (every eligible loop at once, bounded by
maxConcurrent) is intended behavior, not a defect to smooth. Two smaller pins: the daily window
persists at tick-end save only (a crash loses the interrupted run's spend — an acceptable
undercount for a safety valve; no mid-tick save added), and renderStatus/gui.ts derive the per-
row `budgetPaused` flag from one fleet-wide predicate computed off `snap.budget`. Nothing
structural changed; the plan is ready for the feature loop.

**Re-audited 2026-08-30 (plan loop) — the code has fully landed; what remains is the test suite
plus the README clause, all pickable independently.** Feature tick 62 (`041fd55`) implemented the
full design and coverage tick `01c28ce` landed the gate e2e; verified at `5be72e9`: build clean,
suite 450/450. Every code clause of the acceptance criteria is in place: config (default 50 in
`defaultConfig`, TOP_LEVEL_KEYS, `checkNumber … >= 0` with "0 disables" — src/config.ts); state
helpers (`todayStamp`/`dailyCost`/`recordDailyCost`/`fleetDailyCost`/`budgetPaused` in
src/state.ts; `freshLoopState` defaults the window to `""`/`0`; merge-over-fresh loads old files
unchanged); the write path (`foldUsage` → `recordDailyCost`, so every pi run of a tick routes
through it — src/loop.ts); the gate (the poll loop computes the predicate once per cycle from all
runners' states and the live config, skips role runners before `isEligible`, director exempt; one
harness-level transition event each with spentUsd/capUsd — src/orchestrator.ts); display
(`StatusSnapshot.budget` null when disabled; header badge standing while enabled; `loopPhase`
trailing flag → `budget paused` for idle role rows on both surfaces, derived once from the
snapshot — src/status.ts, status-render.ts, gui.ts, gui-page.ts); and the e2e (tiny $0.50 cap vs a
$1 fake run: the startup tick lands the spend with one transition event, the scheduled nextRunAt
passes while paused with no second tick, a queued director prompt still runs, and a live raise to
100 resumes within one poll with exactly one resume event; the predicate sums every runner's
state — director included (src/orchestrator.ts) — so the director's spend counts toward the cap as
designed). What remains against the acceptance criteria — six items, all test
work plus one README edit, pickable independently:

(a) **state-helper units** in test/state.test.ts (AC6 "units for every pure helper"; AC2's test
clauses) — today the file has zero references to any of the five helpers: `recordDailyCost`
accumulates same-day and rolls over at local midnight on write (a tick crossing midnight
attributes its spend to the new day); `dailyCost` reads $0 for a stale or missing stamp and the
window's value when fresh, never mutating; `fleetDailyCost` sums across loops with stale ones
reading $0; `budgetPaused` is false at cap 0 (disabled) and below the cap, true at/above it. Two
clause extensions: the existing "zeroCounters zeroes … preserves everything else" test gains an
assertion that dayStamp/dayCostUsd survive (AC2's reset-counters clause — the fields postdate the
test), and "loadLoopState fills fields missing from an older or partial file" gains a saved-file-
without-the-fields case reading $0 through `dailyCost`.
(b) **config units** in test/config.test.ts (AC1's test clauses) — no maxDailyCostUsd assertion
exists: defaultConfig carries 50; negative and non-numeric values rejected with actionable errors
like the thrash-thresholds test above it; a typo'd key name fails via TOP_LEVEL_KEYS' unknown-key
error; loadConfig over an existing file lacking the key picks up the default without editing.
(c) **event rendering units** in test/event-format.test.ts (AC4's render clause) — no budget case
exists: `budget_paused` and `budget_resumed` render as plain lines carrying spend and cap, no
warning prefix, like counters_reset.
(d) **GUI surface units** in test/gui.test.ts (AC5's GUI half; the TUI half is covered by
test/status-render.test.ts) — /api/status carries `budget` while enabled and null when disabled;
the served page's header assembly includes the badge; a paused fleet's per-loop phase payload
reads `budget paused` for idle role loops.
(e) **two untested AC3 clauses** in test/orchestrator.test.ts (small additions to the existing
gate e2e or a sibling test): startup with spend already at cap starts no role ticks (pre-seed a
state file with today's stamp and spend ≥ cap before starting the orchestrator), and a main-moved
wake while paused stays blocked (advance main after the pause, assert no tick across several
polls). In-flight completion is recorded as a structural guarantee rather than tested: spend folds
only at run end (`foldUsage` post-run), so a tick cannot be paused by its own spend mid-run, and
the gate skips scheduling only — nothing kills an in-flight task.
(f) **README clause** (the plan's README section): `maxDailyCostUsd` is documented nowhere outside
the status section — Usage gains what it caps (role loops' new ticks, per local day), that 0
disables, that the director is exempt, and that edits apply live within ~2 s; How-it-works gains a
short paragraph on pause/resume behavior and the two events.

Nothing structural remains in code — every AC's code clause verified landed above; items (a)–(e)
are pure test work and (f) is documentation. Once all six land, move this plan to Done. Files for
the remainder: test/state.test.ts, test/config.test.ts, test/event-format.test.ts,
test/gui.test.ts, test/orchestrator.test.ts, README.md.

**Re-audited 2026-08-31 (plan loop) — items (a), (b), (c), (d), and (e) have LANDED; only the
README clause remains.** The remainder list above is stale on current main (`b589e09`): five of
the six items landed since this entry's last audit, verified at `b589e09` with a green build and
a 468/468 suite. (a) in coverage tick `07d5bf6` — recordDailyCost same-day accumulation and
midnight rollover on write, dailyCost's stale/missing → $0 non-mutating reads, fleetDailyCost
summing with stale loops at $0, budgetPaused at cap 0 / below / at-or-above, plus the
zeroCounters-preservation and loadLoopState missing-fields assertions (test/state.test.ts). (b) in
coverage tick `2fbfb49` — defaultConfig carries 50; negative/non-numeric values rejected with
actionable errors; a typo'd key fails via TOP_LEVEL_KEYS' unknown-key error; loadConfig over an
existing file lacking the key picks up the default without editing (test/config.test.ts). Coverage
tick `92a4ffe` then landed one unit beyond the six — snapshot()'s budget wiring in test/status.
test.ts (today's spend summed from persisted loop state, stale stamps reading $0; cap 0 drops the
badge data). Feature tick 65 (`b589e09`, current HEAD) closed the last three test items in one
commit (+165 lines across three files): (c) "formatEvent renders the budget transition events
plainly with spend and cap" — both events carry spend and cap, no warning prefix, plus a torn-line
fallback that still renders; (d) three GUI tests — /api/status carries `budget` while enabled and
null when disabled (today's spend read from persisted loop state), the served page derives its
header badge from the payload, and a paused fleet's idle role loops read `budget paused` in their
phase payload with the director exempt and an under-cap fleet leaving the label; (e) both AC3
clauses exactly as specified — "startup with spend already at the cap starts no role ticks"
(pre-seeded daily window at the cap, several poll cycles pass with zero ticks and exactly one
budget_paused event carrying spentUsd/capUsd) and "a main-moved wake while budget-paused stays
blocked" (main advanced after the pause; no tick across several polls and no `wake` event). Item
(f) verified still unlanded: `maxDailyCostUsd` appears nowhere in README.md outside the status
block. What remains — one item, a single documentation edit per its spec above: (f) **README
clause** — Usage gains what it caps (role loops' new ticks, per local day), that 0 disables, that
the director is exempt, and that edits apply live within ~2 s; How-it-works gains a short
paragraph on pause/resume behavior and the two events. Once it lands, move this plan to Done.
Files for the remainder: README.md only.

**Done 2026-08-31 (feature tick) — item (f), the last remainder, has landed; nothing remains.** The
README clause per its spec above: Usage documents `maxDailyCostUsd` — what it caps (role loops' new
ticks, per local day), that 0 disables, that the director stays exempt, and that edits apply live
within ~2 s — and How-it-works gains a short paragraph on pause/resume behavior and the two
transition events. Items (a)–(e) had all landed before this tick — coverage ticks `07d5bf6`,
`2fbfb49`, and `92a4ffe`, plus feature tick 65 (`b589e09`) for items (c)–(e) — so the change is
documentation only: README.md plus this PLANS.md move. Verified against main `1ee92c3`: build clean,
suite 469/469 (no code or test files touched). Files: README.md, PLANS.md.

### The right to refuse, and friction as a signal (planned 2026-08-24, refined 2026-08-25,
refined 2026-08-27, audited 2026-08-28, re-audited 2026-08-29, re-audited 2026-08-29
(item (a) landed; remainder re-specified), re-audited 2026-08-30 (items (b)–(e) landed;
one residual remains), done 2026-08-30)

Full plan: [plans/refusal-and-thrash.md](plans/refusal-and-thrash.md). A new
`TUMWATER_REFUSED: <reason>` sentinel and `refused` tick outcome let a loop decline work that
would harm the architecture, recording the objection in PLANS.md/BUGS.md. Discard semantics are
decided: the markdown note always commits and merges (the durable record); any non-markdown
half-work is discarded — tracked edits via reset, untracked files via clean; a no-note refusal
resets cleanly with the reason kept in event + lastSummary. High-friction ticks (turn/time
thresholds from `PiRunResult.turns` + wall-clock) are flagged by warning event and, once
commit-bodies lands, its reserved trailer line — matsemann's "difficulty is a signal" restored as
data. A refusal blocks its entry until unblocked: fixed `**Refused <date> by <role>: …**` note
shape, a COMMON_RULES skip rule plus feature/bugfix find-text lines keep fresh-session ticks from
re-refusing the same entry (normal backoff bounds any violation), and only a human or the
director clears it — the steward may prune stale ones.

**Status (plan-loop audit 2026-08-28):** feature tick 51 (`c2f541a`) landed the full design;
verified at `8ea49b8` with a green build and a 339/339 suite. Sentinel: `REFUSED_SENTINEL`
beside `NOTHING_TO_DO`, COMMON_RULES bullet carries the recording rule, the fixed
`**Refused <YYYY-MM-DD> by <role>: …**` note shape, and the skip rule in one place (src/prompt.ts).
Parser: whole-reply scan sets `PiRunResult.refused`; the reason comes from line-anchored
`extractRefusal` on the first parseable sentinel line — prose that merely mentions the sentinel
cannot set it (src/pi.ts, src/prompt.ts). Loop: `handleRefusal` classifies via `changedFiles`
(porcelain paths) — md-only commits through the shared `buildCommitMessage` as
`tumwater(<role>): refuse — <reason>` (subject + trailer only, no body) and merges directly,
deliberately bypassing the gate since md-only diffs are review-exempt by construction; mixed
changes stage only the markdown paths via `commitPathsAndDiscardRest` then discard tracked edits
(`reset --hard HEAD`) and untracked files (`clean -fd`); a no-note refusal resets to main with
the reason kept in event + lastSummary. Scheduling: `refused` falls through to the backoff
branch exactly as planned (backoff like no_change), `lastResult = "refused"` / `lastSummary`
= reason render in both dashboards for free. Thrash: `tickTurns > thrashTurns || minutes >
thrashMinutes` at tick end sets `highFriction`, logs the warning event with thresholds, passes
the flag into `buildReviewPrompt` ("HIGH-FRICTION … extra scrutiny") and annotates finalSummary;
`tickTurns` is the same counter commit-bodies' trailer reads. Config: defaults 40/60 plus
`>= 0` validation (src/config.ts, src/types.ts). Prompts: feature find-text gains refuse-rather-
than-force + skip line, bugfix its analogue (src/roles.ts), and the director's routing block
gains the unblock line. Remaining — three items against the acceptance criteria:
(a) **the entire planned test suite is missing** — `test/refusal.test.ts` never landed; grep
finds zero refusal tests anywhere under test/. Per the plan's Files-touched list: sentinel parse
(`extractRefusal` + parser flag); md-only refusal commits and merges (loop e2e, note lands on
main with outcome `refused`); mixed refusal keeps the note and discards tracked *and* untracked
code changes (loop e2e); no-note refusal resets cleanly with the reason in event + lastSummary;
thrash flag set past either threshold; plus prompt-contract assertions — skip rule in
COMMON_RULES, feature + bugfix find-text lines, director's unblock-routing line. (b) **AC3's
trailer line was never implemented**: commit-bodies.md has since landed and reserved the slot
("The high-friction flag … appends to this line when set"), but `commitTrailer`
(src/commit-message.ts) takes no friction argument — a changed tick past either threshold
carries no marker in git history; only the event, lastSummary, and review prompt do. Small code
change: optional flag on `commitTrailer`, passed from loop.ts's changed-tick path, with unit +
e2e assertions on the trailer content. (c) **AC5 untested**: config validation for
`thrashTurns`/`thrashMinutes` has no assertions in test/config.test.ts. Files for the remainder:
test/refusal.test.ts (new), src/commit-message.ts, src/loop.ts, test/commit-message.test.ts,
test/config.test.ts.

**Re-audited 2026-08-29 (plan loop) — item-(a) claim corrected; trailer format decided.** The
"entire planned test suite is missing" claim above is stale on current main: the sentinel-parse
half has landed. Coverage tick `0326a2a` added test/refusal.test.ts — `extractRefusal` units
(line-start anchor, whitespace tolerance, bare-sentinel null, mid-sentence mention ignored,
first parseable line wins) and parser-flag tests (refused + reason captured; intermediate-message
regression; empty reason for a bare sentinel). Coverage tick `82c7631` then tested the refusal
path's git helpers in test/git.test.ts — `changedFiles` (clean tree; modified/untracked/deleted by
repo-relative path; C-quoted porcelain decoding) and `commitPathsAndDiscardRest` (null with no side
effects when nothing stageable; null when the paths hold no changes; commits only the given paths,
discards every other change) — and in doing so fixed a real bug: `unquotePorcelainPath` decoded
non-ASCII C-quoted paths one octal escape at a time into characters instead of collecting latin1
bytes first and reassembling as UTF-8 (`héllo.md` came back `hÃ©llo.md`) — a refusal note in a
non-ASCII-named file would have staged the wrong path. Verified at `c0ec4b`: build clean, suite
391/391. What actually remains — five items, pickable independently: (a) **loop e2e** in
test/loop.test.ts (zero refusal tests there today): md-only refusal — fake pi appends a Refused
note to PLANS.md and ends with the sentinel → outcome `refused`, note lands on main under subject
`tumwater(<role>): refuse — <reason>`; mixed refusal — note plus a tracked src edit plus an
untracked file → note commits and merges, both code changes discarded (worktree clean at tick end);
no-note refusal — bare sentinel with no edits → worktree reset to main, outcome `refused`, reason
in event + lastSummary. (b) **thrash flag** in test/loop.test.ts: a changed tick past either
threshold sets `highFriction` — warning event carrying the thresholds, `TickOutcome.highFriction`
set, review prompt carries its HIGH-FRICTION marker; one test per threshold (low `thrashTurns`,
low `thrashMinutes`). (c) **prompt contract** in test/prompt.test.ts: assert the four shipped
strings — COMMON_RULES skip rule ("skip entries carrying a Refused note"), feature find-text line,
bugfix analogue, director's unblock-routing line. (d) **AC3's high-friction trailer line** — small
code change, format now decided below. (e) **AC5 config validation** in test/config.test.ts:
defaults 40/60 present; negative and non-numeric `thrashTurns`/`thrashMinutes` rejected with
actionable errors.

**Trailer format (decided):** commit-bodies.md's reservation ("appends to this line when set") is
refined into a sibling git-trailer line after the Tick line — `Friction: high (<turns> turns /
<minutes>m)`, minutes rounded, e.g. `Friction: high (41 turns / 62m)` — rather than an extension of
the Tick line itself: that keeps the Tick line's asserted format stable and gives minutes (absent
from it) a home. Mechanically: `commitTrailer` gains an optional fifth argument
(`highFrictionMinutes?: number`) whose presence appends the line; src/loop.ts's changed-tick call
site passes `highFriction ? minutes : undefined` — both are already computed before the commit, so
no reordering; the refusal-path call site is untouched (a refused tick is not a "changed" tick and
the flag is defined for changed ticks only); update the two stale comments that say the flag stays
visible in event/lastSummary/review-prompt until this lands. Tests: unit in
test/commit-message.test.ts (with-flag exact format; without-flag unchanged) plus an e2e in
test/loop.test.ts that a low-threshold changed tick's commit carries the Friction line in its git
log. Files for the remainder: src/commit-message.ts, src/loop.ts, test/loop.test.ts,
test/prompt.test.ts, test/commit-message.test.ts, test/config.test.ts. Nothing structural remains
beyond item (d)'s small code change; items (a)–(c) and (e) are pure test work.

**Re-audited 2026-08-29 (plan loop) — item (a) has LANDED; remainder re-specified.** The
"zero refusal tests there today" claim is stale on current main (`8191c0b`): coverage tick
`bc479b6` landed the loop-e2e half of item (a) in test/loop.test.ts, after this entry's last
audit. Two tests: (1) "a refused tick lands only its markdown note, discards code changes, and
skips review" — fake pi appends a Refused note to PLANS.md plus one tracked edit (`seed.txt`)
and one untracked file (`broken.ts`), ends with the sentinel → outcome `refused`, summary =
reason, note on main under subject `tumwater(improve): refuse — it would delete user data`, both
code changes discarded (worktree clean at tick end) — covering the spec's md-only *and* mixed
cases in one test; a counter file outside the worktree proves exactly one pi run total, i.e. the
note commit bypassed the review gate as designed. (2) "a refused tick with no note resets the
worktree and reports a fallback reason" — bare sentinel plus untracked half-work → nothing lands
on main, worktree reset clean, `outcome.summary` = "no reason given". One residual against item
(a)'s spec: neither test reads the event log, so the no-note refusal's "reason in *event* +
lastSummary" is only half-asserted (lastSummary via outcome) — fold that assertion into item (b)
below; its e2e already inspects events.

What remains — four items, pickable independently: (b) **thrash flag** in test/loop.test.ts —
one test per threshold plus a negative control. Turns: config `thrashTurns: 1`, fake pi emits
two assistant messages and makes a file change → changed tick; assert the warning event message
carries both thresholds ("high-friction tick: … (thresholds: …)"), `outcome.highFriction` set,
and the reviewer run's prompt contains its HIGH-FRICTION marker — the fake pi identifies
reviewer runs by their "adversarial code reviewer" text (the pattern test/loop.test.ts already
uses for VERDICT runs) and records that run's args to a file. Minutes: config `thrashMinutes: 0`
(validation allows ≥ 0), fake pi sleeps ~1 s before replying so elapsed minutes exceed 0 at one
turn; same assertions. Negative control: default thresholds, ordinary changed tick → no
high-friction warning event and `outcome.highFriction` unset. (c) **prompt contract** in
test/prompt.test.ts — assert the four shipped strings through the built prompts (feature/bugfix/
director), not just constants: COMMON_RULES skip rule ("skip entries carrying a Refused note —
do not pick them and do not re-refuse them"), feature find-text ("Skip plans whose entry carries
a Refused note."), bugfix analogue ("Skip BUGS.md entries\ncarrying a Refused note." — note the
line wrap), director routing block ("A decision about a refused entry" … "clear its **Refused
…** note from PLANS.md/BUGS.md"). (d) **AC3's high-friction trailer line** — small code change,
format decided above: `commitTrailer` gains an optional fifth argument
(`highFrictionMinutes?: number`) whose presence appends the sibling line `Friction: high
(<turns> turns / <minutes>m)`; src/loop.ts's changed-tick call site passes `highFriction ?
Math.round(minutes) : undefined` (both already computed before the commit); the refusal-path
call site is untouched; update the stale comment(s) that say the flag stays visible in
event/lastSummary/review-prompt until this lands — loop.ts:621-622 ("until commit bodies carry a
dedicated trailer line, those are where it stays visible") is one. Unit tests in
test/commit-message.test.ts (with-flag exact format; without-flag unchanged). (e) **AC5 config
validation** in test/config.test.ts — defaults 40/60 present in `defaultConfig()`; negative and
non-numeric `thrashTurns`/`thrashMinutes` rejected with actionable errors, like the other
numeric fields' existing assertions.

Synergy for whoever picks (b)+(d) together: item (b)'s turns-threshold e2e *is* item (d)'s
planned e2e — one high-friction changed tick can assert the warning event, `outcome.highFriction`,
the reviewer prompt marker, and the `Friction:` line in that commit's git log in a single test;
only the minutes-threshold test and the units are extra. Files for the remainder: src/commit-
message.ts, src/loop.ts, test/loop.test.ts, test/prompt.test.ts, test/config.test.ts,
test/commit-message.test.ts. Nothing structural remains beyond item (d)'s small code change;
items (b), (c), and (e) are pure test work.

**Re-audited 2026-08-30 (plan loop) — items (b), (c), (d), and (e) have LANDED; one residual
remains.** The "four items, pickable independently" list above is stale on current main
(`da79bcd`): all four landed since the last audit. (c)+(d)+(e) in feature tick 57 (`c477ce9`):
the prompt-contract assertions are in test/prompt.test.ts (COMMON_RULES skip rule, feature +
bugfix find-text lines, director unblock-routing line — matched with whitespace collapsed after
that tick's reflow break, fixed by improve tick `06de235`, BUGS.md Fixed); `commitTrailer`'s
optional fifth argument appends the decided `Friction: high (<turns> turns / <minutes>m)`
sibling line, unit-tested in test/commit-message.test.ts; and test/config.test.ts asserts the
40/60 defaults plus rejection of negative/non-numeric thresholds. (b) in feature tick 59
(`7212a7e`): three loop e2es in test/loop.test.ts exactly as specified — turns threshold
(`thrashTurns: 1`, two assistant turns → changed; warning event carrying both thresholds,
`outcome.highFriction`, the reviewer prompt's HIGH-FRICTION marker via recorded args, and the
`Friction:` line in that commit's git log, doubling as item (d)'s e2e), minutes threshold
(`thrashMinutes: 0` with a ~1 s sleep at one turn; same assertions minus the trailer), and a
negative control under default thresholds asserting no flag, no warning event, no marker, and no
Friction line. Tick 59 also made one small code change worth recording: friction is now measured
over the tick's authoring runs only — `authoringTurns` snapshots `tickTurns` before the review
gate, which folds its own run into the counter after the commit, so every friction artifact (flag,
warning event, trailer line, final summary) reads the pre-gate value and reviewer turns never
count toward thrash. Verified at `da79bcd`: build clean, suite 435/435.

What remains — one item: **AC2's event half for a no-note refusal is untested.** The existing
test "a refused tick with no note resets the worktree and reports a fallback reason"
(test/loop.test.ts) asserts `outcome.summary` but never reads the event log; this entry's
2026-08-29 re-audit said to fold that assertion into item (b), whose e2e already inspected
events — tick 59 did not. Spec: in that test, read the event log (`readEvents(repo)`, used by
the thrash tests above it), find the `tick_end` event for the tick, and assert `result ===
"refused"` and `summary === "no reason given"` — the generic end-of-tick event is where a no-note
refusal's reason lives (`handleRefusal` logs nothing of its own). That closes AC2's last untested
clause; once it lands, move this plan to Done. Files: test/loop.test.ts only.

**Done 2026-08-30 (feature tick) — the last residual has landed; nothing remains.** The event
half of AC2 for a no-note refusal is now tested, exactly as the re-audit specified: "a refused
tick with no note resets the worktree and reports a fallback reason" in test/loop.test.ts reads
the event log (`readEvents`), finds that tick's `tick_end` event, and asserts `result ===
"refused"` and `summary === "no reason given"` — the generic end-of-tick event is where a no-note
refusal's reason lives (`handleRefusal` logs nothing of its own). That closes AC2's last untested
clause; every acceptance criterion of plans/refusal-and-thrash.md is now met or tested. Verified:
build clean, suite 435/435. Files: test/loop.test.ts only.

### Questions outbox — loops that know when to ask (planned 2026-08-24, refined 2026-08-25,
refined 2026-08-26, audited 2026-08-28, re-audited 2026-08-29, done 2026-08-29)

Full plan: [plans/questions-outbox.md](plans/questions-outbox.md). A tracked QUESTIONS.md
(Open/Answered) any loop appends to when a decision is genuinely the user's — context, options,
and the loop's recommendation. Surfaced alongside planned features and open bugs (user note
2026-08-26): an *open questions* section in the GUI project status panel and the TUI Ctrl+T
project-status view, reusing src/backlog.ts's `parseEntries` — superseding the earlier
`/api/questions` panel-on-click design; plus a `questions: N` header badge (count via
StatusSnapshot like inbox). Answers flow back by editing the file or via the director. Loops
never block on their own questions. The report's answer to "software lacks victory conditions":
be excellent at requesting them.

**Status (plan-loop audit 2026-08-28):** feature tick 52 (`2547b4d`) landed the full design;
verified at `2d3376f` with a green build and a 355/355 suite (the tick's own build break — stale
test call sites for its new required `questions` field and third `backlogLines` argument — is
fixed, see BUGS.md). Init: QUESTIONS.md seeds beside PLANS/BUGS and test/init.test.ts asserts it
in the committed-file list. Prompt contract (src/prompt.ts): the read-first list names
QUESTIONS.md; COMMON_RULES carries the ask-don't-guess bullet in full — context, options, own
recommendation, continue-or-end, never block, check for answers at tick start, no re-asking;
the director's routing block has the answer-routing bullet (move the entry to ## Answered
verbatim with the decision recorded, apply or route follow-on work). Reader: `openQuestions(root)`
lives in src/backlog.ts rather than a separate src/questions.ts as the Files list said — within
the plan's own discretion ("or in questions.ts, delegating to it"), so count and list come from
one parse; missing or unreadable file yields []. Surfaces: `StatusSnapshot.questions` is required
and flows like inbox; both dashboards show the header badge only when N > 0 (`· questions: N`,
status-render.ts + gui-page.ts); the GUI payload carries a fresh-per-poll `questions` list and
the #backlog panel renders an *open questions* section via the shared backlogList helper with
`(none)` when empty; the TUI Ctrl+T project-status view passes openQuestions as backlogLines'
third argument (subheader + entries or `(none)`) and shows a highlighted nudge line `questions:
N awaiting answers (see QUESTIONS.md)` above the activity pane while any await. Events:
`question_posted` is in the HarnessEvent union with plain rendering, no warning prefix.
Remaining — two items against the acceptance criteria, nothing structural: (a) **the event
emission was never implemented** — tryMerge (src/loop.ts) has no before/after open-question
count diff; the type and rendering exist but nothing emits `question_posted`, so a merged
question is invisible in `tumwater logs` until this lands. Small code change per the plan: capture
`openQuestions(root)` before the rebase, compare after `ffMergeToMain` succeeds, log one event
per new heading alongside `merged`. (b) **the planned test suite never landed** — no
test/questions.test.ts; today's only coverage is incidental from the build-break fix (backlogLines
subheader lines in test/tui.test.ts, `questions: 0` in snapshotWith). Missing against the plan's
Files list: openQuestions reader units (section isolation / missing file → [] / placeholder skip)
in test/backlog.test.ts; header-badge rendering at N > 0 on both surfaces; prompt-contract
assertions (ask-don't-guess bullet, director answer-routing bullet); GUI payload field + panel
section; TUI project-status view list and nudge line; and a loop e2e that a tick adding an Open
entry emits `question_posted` alongside `merged` — which doubles as the regression for item (a).
Files for the remainder: src/loop.ts, test/questions.test.ts (new), test/backlog.test.ts,
test/status-render.test.ts, test/gui.test.ts, test/tui.test.ts, test/prompt.test.ts.

**Re-audited 2026-08-29 (plan loop) — most of item (b)'s suite has landed; file reference
corrected; remainder re-specified.** The audit above is stale on current main (`43267c3`): the
openQuestions reader units have landed in test/backlog.test.ts (section isolation, missing file →
[], placeholder skip, fresh-read visibility of an answer), and coverage tick `0294f45` landed the
GUI payload field + panel section + header-badge page tests in test/gui.test.ts; the TUI project-
status view's list is covered by the backlogLines subheader units already present in
test/tui.test.ts. All code has landed except the emission itself: init seeding, the prompt contract
(read-first line names QUESTIONS.md; ask-don't-guess bullet; director answer-routing bullet — all
in src/prompt.ts), `StatusSnapshot.questions`, the status-render header badge (`· questions: N`
only when > 0), and the TUI nudge line (bold `questions: N awaiting answers (see QUESTIONS.md)`
above the activity pane while any await) are in place. One file reference is stale: organize commit
`467504c` extracted the merge machinery out of src/loop.ts into src/merge.ts — tryMerge now lives
there, so item (a)'s code change and its Files list move with it. What remains — five items,
pickable independently:

(a) **the emission** in tryMerge (src/merge.ts): inside the `withLock` section, capture
`before = openQuestions(ctx.root)` before `rebaseOntoMain`; after `ffMergeToMain` succeeds, read
`after` and log one `{ loop: ctx.role, type: "question_posted", question: <heading> }` per heading
in `after` not in `before`, alongside the existing `merged` event (import openQuestions from
./backlog.js). The lock makes the diff exact — no other merge can land between capture and compare,
and on the conflict path only the second tryMerge call ever reaches the post-ff code, so nothing
double-emits. The rendering already reads `e.question`.
(b) **loop e2e** in test/loop.test.ts: a tick that appends an Open entry to QUESTIONS.md merges as
md-only and emits `question_posted` alongside `merged` — assert both events in the event log with
question = the new heading; doubles as the regression for (a).
(c) **prompt contract** in test/prompt.test.ts: read-first list names QUESTIONS.md; ask-don't-guess
bullet ("do not guess: append a question to QUESTIONS.md"); director answer-routing bullet ("An
answer to an open question" … "## Answered verbatim"). Match content with whitespace collapsed, not
layout — the tick-57 reflow break (BUGS.md) is the cautionary tale.
(d) **header badge at N > 0** in test/status-render.test.ts: renderStatus's header line carries
`· questions: N` when snap.questions > 0 and omits it at zero (the GUI page's badge is already
tested; this covers the TUI/one-shot surface).
(e) **TUI nudge line** in test/tui.test.ts: while any question awaits, a highlighted `questions: N
awaiting answers (see QUESTIONS.md)` line appears above the activity pane and disappears at zero.

Files for the remainder: src/merge.ts, test/loop.test.ts, test/prompt.test.ts,
test/status-render.test.ts, test/tui.test.ts. Nothing structural remains beyond item (a)'s small
code change; items (b)–(e) are pure test work.

**Done 2026-08-29 (plan-loop audit) — all five remaining items have landed; nothing left.**
Feature tick 58 (`1a48edc`) closed four of the five in one tick. (a) The emission in tryMerge
(src/merge.ts): `before = openQuestions(ctx.root)` captured inside withLock before rebase, and one
`{ loop, type: "question_posted", question }` per heading present after ffMergeToMain but absent
from `before`, logged alongside the existing `merged` event — exactly as specified. (b) The loop
e2e in test/loop.test.ts: a tick that posts an Open entry merges as md-only (exactly one pi run,
gate skipped by construction), and the event log carries both `merged` and exactly one
`question_posted` naming the new heading, with a negative control proving a non-question change
emits none. (c) The prompt contract in test/prompt.test.ts: read-first list names QUESTIONS.md,
ask-don't-guess bullet, director answer-routing bullet — all matched with whitespace collapsed per
the tick-57 reflow caution. (d) The header badge at N > 0 in test/status-render.test.ts: `·
questions: N` present when snap.questions > 0, omitted at zero. Coverage tick `931ca26` closed the
last item: (e) the TUI nudge line is tested by "open questions add a nudge line above the activity
pane" — absent while QUESTIONS.md's Open section is empty, present as `questions: 1 awaiting
answers` after posting an entry. One file deviation from this entry's spec, recorded rather than
forced: item (e) named test/tui.test.ts, but frame-level runTui assertions live in the fake-TTY
integration harness test/tui-run.test.ts, which is where it landed; the backlogLines subheader
units remain in test/tui.test.ts as before. Verified at `15657bd`: build clean, suite 423/423 —
every acceptance criterion of plans/questions-outbox.md now met or tested.

### Adversarial review gate before merge (planned 2026-08-24, refined 2026-08-25, refined
2026-08-27, audited 2026-08-27, re-audited 2026-08-28, refined 2026-08-28 (build pre-check),
refined 2026-08-28 (pre-check disambiguated + unblocked), audited 2026-08-29 (build pre-check
landed in feature tick 54; remainder is tests), re-audited 2026-08-29 (test-suite status
corrected), done 2026-08-29)

Full plan: [plans/review-gate.md](plans/review-gate.md). No code diff reaches main unreviewed: a
fresh-session pi run (no author context; own model override via optional provider/model/thinking on
the new top-level `review` config section — role validation rejects pseudo-role ids) reviews
the full ahead-of-main diff against PRINCIPLES.md and replies `VERDICT: approve|reject` with
reasons. Rejects reset the branch, record reasons, and inject them into the author's next tick —
the only cross-tick memory, since sessions are fresh per tick; md-only diffs are exempt so notes
stay cheap. The invariant is structural — a failed or verdict-less review fails closed (commit
stays on the branch for re-review next tick, 3-strike discard cap), and both `recoverLeftover`'s
salvage and resumed ticks' leftover commits route through the same gate so no crash path can land
unreviewed work. The report's highest-leverage item — we have merged broken work twice for lack of
it.

**Status (plan-loop audit 2026-08-27, re-audited 2026-08-28):** feature tick 47 (`74224e9`) wired
the gate into the main tick path; all five remaining items from the 2026-08-27 audit are now
verified landed (checked at `97e3e94`, build green, suite 324/324): (1) `runTick` calls the gate
after `commitAll`, before `merge`, with the full GateResult → outcome mapping (`aborted` re-queues
a director prompt; reviewer usage folded via `foldUsage`); (2) `"rejected"` schedules like
`"changed"` — backoff reset, next tick at minTickInterval, no commit counted; (3) `state.phase`
clears at tick end except on abort (deliberate: an aborted mid-review tick must recover and
re-review fresh, not resume the author session whose work is already committed); (4)
test/review.test.ts covers the pure functions plus gate orchestration — approve + stray-edit
discard, reject reset + reasons recorded, verdict-less fail-closed keep, 3-strike discard,
doc-only exemption without a pi run, `enabled: false` no-op, `lastApprovedHead` skip, `-recovery`
session suffix, abort with no bookkeeping — and loop.test.ts routes fresh/resumed/recovered ticks
through the gate; (5) all four review event types render in `formatEvent`, and status shows
`reviewing <elapsed>` while under review. Remaining — two test gaps plus the build pre-check below, nothing
structural; item (a) from that list has since landed: coverage tick `8ea49b8` added the
tick-level e2e (a rejected change's reasons appear in the role's next prompt), and unit tests for
`buildRejectedReviewNote` are in test/prompt.test.ts. Still open: (b) "the merge lock is not held
during review" is structurally true (the gate runs before `withLock`) but untested — two fake-pi
loops, one under review while the other merges; (c) the `reviewing <elapsed>` state cell has no
test in test/status-render.test.ts. Files for those: test/loop.test.ts or test/review.test.ts,
test/status-render.test.ts.

**Refined 2026-08-28 — deterministic build pre-check (new remaining item).** The BUGS.md entry
(now fixed, under Fixed) named the hole this plan left: feature tick 49 broke main's build *with
the gate active* because the reviewer is forbidden from running state-changing commands and `npm
run build` is exactly that (`rm -rf dist && tsc`) — type errors are invisible to a model that
cannot compile, and broken work has now landed on main six times. The refinement (full design in
plans/review-gate.md): the harness itself runs the project's declared npm `typecheck`/`build`
script as a deterministic first step of the gate — after the md-only exemption, before any
reviewer run; a failure rejects through the existing reject path with the compiler tail as reasons
(no pi run consumed), a timeout warns and proceeds to model review. No config knob: detection is
the project's `package.json` scripts plus a `node_modules` presence check, resolved by walking up
from the worktree — a literal `<wt>/node_modules` check would never fire, because tumwater's own
worktrees carry no install (only the main repo root does). Joins items (b)–(c) above; **unblocked
as of this refinement** — main's build has been green since `c02189c` (suite 355/355 at
`ec17c86`).

**Audited 2026-08-29 (plan loop) — the build pre-check has LANDED; what remains is its test
suite plus items (b)–(c), all test work.** Feature tick 54 (`93d14f5`) implemented the full
design in src/review.ts (+181 lines); verified at `fda67b8` with a green build, and this audit
exercised the dogfood mechanism end-to-end: from a worktree carrying no local install,
`detectBuildCheck` resolves the main repo root three levels up (package.json + node_modules; no
`typecheck` script here, so `build`) and `npm run build` with cwd = worktree compiles the
worktree's own tracked sources — npm walks up to the root's node_modules for tsc — into the
gitignored dist/, leaving the tree clean in ~1 s. The code matches the design: placement inside
`reviewAheadOfMain` after both early returns (already-approved-HEAD skip, exemption short-circuit)
and before `review_start`/`state.phase = "review"`, so a deterministic rejection never shows as
"reviewing"; nonzero exit rejects through the existing reject path verbatim (`resetWorktreeToMain`,
`state.lastReview`, `review_rejected` event, next-prompt injection; no pi run consumed —
`GateResult.run` absent — and `unreviewFailures` reset like a model reject); timeout or spawn-ENOENT
warns ("build check timed out after Ns; proceeding to model review" / "no npm on PATH; skipping
build check") and proceeds, deliberately not fail-closed. One deviation from the plan's letter,
recorded rather than forced: machine-generated reasons join the header to the FIRST output line —
`build check failed (<script>): <first compiler line>` — with the rest of the clipped tail as
subsequent reasons, so the compiler error sits right after its header in the injected next-tick
note. `clipBuildTail` keeps the last ≤10 non-empty lines, each via the existing 300-char clip; the
300 s cap is a module constant exposed as the `buildCheckTimeoutMs` test seam on ReviewContext.
**Zero tests landed with it**: nothing under test/ references detectBuildCheck / runBuildCheck /
clipBuildTail / BUILD_CHECK_TIMEOUT_MS, so the acceptance criteria's "unit-tested" clause is unmet
and a syntax or type error in this code would ship silently — the exact failure mode that motivated
the pre-check. Remaining, all test work, pickable independently: (1) **pre-check units** in
test/review.test.ts — detectBuildCheck over scratch dirs (dogfood walk-up shape with an empty
node_modules/ at the qualifying ancestor; nearest-qualifying-wins when two ancestors qualify;
typecheck preferred over build; neither script → null; malformed package.json → null; no
qualifying ancestor within maxLevels → null — detection never throws); runBuildCheck against a
scratch project (passing script → passed; failing script → failed with the clipped tail; hanging
script + short cap → skipped/timeout; the no-npm branch is reachable by pointing process.env.PATH
at an empty dir around the call, restored in finally); clipBuildTail (tail-of-10, non-empty only,
per-line clip). (2) **gate e2e** — a scratch repo whose root carries package.json + empty
node_modules and a failing `build` script: the gate rejects with zero reviewer pi runs (assert via
the fake-pi argv log the existing orchestration tests already use), branch reset, `review_rejected`
carrying the compiler tail, reasons in the role's next prompt; a passing script still reaches the
reviewer (approve path unchanged); a hanging script + short buildCheckTimeoutMs warns and proceeds.
(3) Items (b)–(c) above are unchanged: merge-lock-not-held-during-review (two fake-pi loops, one
under review while the other merges — test/loop.test.ts or test/review.test.ts) and the
`reviewing <elapsed>` state cell (test/status-render.test.ts). Files for the remainder:
test/review.test.ts, test/loop.test.ts, test/status-render.test.ts. Nothing structural remains in
this plan.

**Re-audited 2026-08-29 (plan loop) — test-suite status corrected.** The "zero tests landed"
claim above was true at its verification point (`fda67b8`) but is stale on current main, where the
remainder list above overstates what is missing: bugfix tick 58 (`038519a`, merged after that
snapshot) already landed a partial pre-check suite in test/review.test.ts — runBuildCheck units
(toolchain resolution from the installed root when the worktree has no node_modules; failing build
→ failed with clipped tail; timeout → skipped), the detectBuildCheck walk-up unit (dogfood shape),
and a gate e2e proving a passing pre-check reaches the reviewer (fake-pi marker, decision
approved). Improve tick `36b0adc` then removed 038519a's PATH-prepend workaround from
runBuildCheck — npm's own run-script (@npmcli/run-script setPATH) walks up ancestor
node_modules/.bin dirs, so no env manipulation is needed; the resolution test pins that behavior.
Verified at `d789962`: build clean, suite 384/384. What actually remains — all test work,
pickable independently: (1) **pre-check unit gaps** in test/review.test.ts — detectBuildCheck edge
cases not yet covered (nearest-qualifying-wins when two ancestors qualify; typecheck preferred
over build; neither script → null; malformed package.json → null; no qualifying ancestor within
maxLevels → null); runBuildCheck's `no-npm` branch (point process.env.PATH at an empty dir around
the call, restore in finally — only the timeout skipReason is tested today); clipBuildTail units
(imported by no test yet: tail-of-10, non-empty lines only, per-line 300-char clip). (2) **gate
e2e gaps** — a scratch repo whose root carries package.json + empty node_modules and a FAILING
`build` script: the gate rejects deterministically with zero reviewer pi runs (assert via the
fake-pi marker the passing-build e2e already uses), branch reset to main, `review_rejected`
carrying the compiler tail, reasons in the role's next prompt; a hanging script + short
buildCheckTimeoutMs warns and proceeds to model review. (3) Items (b)–(c) above are unchanged:
merge-lock-not-held-during-review and the `reviewing <elapsed>` state cell. Files for the
remainder: test/review.test.ts, test/loop.test.ts, test/status-render.test.ts. Nothing structural
remains in this plan.

**Done 2026-08-29 (feature tick) — the remaining test suite landed; nothing structural was left.**
All three open items are covered and the full suite is green (395/395). (1) Pre-check units in
test/review.test.ts: detectBuildCheck over scratch dirs (typecheck preferred over build; nearest
qualifying ancestor wins when two qualify; a first qualifying ancestor with malformed JSON or no
check script is a dead end — an unrelated install further up is never used, and detection never
throws; maxLevels cap); clipBuildTail (tail-of-10, blank lines dropped, per-line 300-char clip);
runBuildCheck's no-npm branch via an emptied process.env.PATH restored in finally. (2) Gate e2e:
a scratch repo whose root carries the install signature and a failing build script — the gate
rejects with zero reviewer pi runs (the fake-pi invocation marker is never touched), branch reset
to main, `review_rejected` carrying the compiler tail, machine-generated reasons recorded; a
hanging script + short buildCheckTimeoutMs warns ("build check timed out after 0.4s; proceeding to
model review") and still reaches the reviewer. A full-tick e2e in test/loop.test.ts proves the
machine-generated reasons ride on the role's next prompt like a model reject's do. (3) Items
(b)–(c): two concurrent fake-pi loops — one under review for ~5s while the other completes its
whole tick including merge, asserting B lands before A's tick ends (the gate runs outside
withLock); and loopPhase renders `reviewing <elapsed>` (with elapsed, bare without a start time,
ahead of live pi detail) in test/status-render.test.ts. Two small code fixes found by the new
tests: clipBuildTail now also drops npm's own script banner (`> pkg@1.0 script`, `> <command>`) —
with little output the first recorded reason was npm's header naming the script, not what broke in
it; and runBuildCheck's doc comment is corrected to describe the actual toolchain mechanism (npm's
run-script prepends node_modules/.bin of every directory from cwd up to root, which covers the
installed repo because worktrees live under it — no env manipulation exists or is needed),
dropping an unused variable and a stale TEMP marker.

### QA role — exercising the product like a user (planned 2026-08-24, refined 2026-08-26,
refined 2026-08-28, done 2026-08-28)

A `qa` role that never edits source: it acts as a first-time user and follows the README's usage
instructions literally in a scratch dir under the system temp (never the worktree or .tumwater/) —
builds the product fresh per its README each tick, runs the built artifact against the scratch dir
(CLI commands, endpoints via curl), checks outputs against what the docs promise, and deletes the
scratch dir when done. Flow selection across fresh sessions: the README's usage section is the flow
menu, ordered cheapest-first with ONE flow per tick; a vary-across-ticks rule prefers flows not
recently exercised as far as BUGS.md filings and Verified notes show; cheap flows that pass leave NO
record (nothing-to-do — a note commit every cadence would move main and wake sleeping loops). The
expensive real-run mode is guarded: prefer a deterministic offline fake/shim when documented, else
ONE real bounded run constrained to minimal scope (an agent harness: exactly one enabled role and
maxConcurrent 1), wall-capped ~10 min including prefill, backgrounded and killed with its whole
process tree — allowed only when the newest `## Verified` note for that flow is older than a day,
and a successful real run appends its one-line note (e.g. `- <date> run (real): init + one tick
landed; status/logs confirm`) at the end of BUGS.md, self-enforcing the daily cap across fresh
sessions without leaking into the dashboards (openBugs parses `## Open` only). Safety rails in the
prompt: every launched process gets a hard time limit and an explicit kill, servers bind ephemeral
high ports never the product's documented default port, no listening process outlives the tick.
BUGS.md is its only write — md-only diffs stay review-exempt, and filings flow to the bugfix loop
through its existing find prompt (QA → bug → fix → reviewed merge). Cadence: `defaultConfig`
carries `{ enabled: true, minTickIntervalSeconds: 7200 }`, so qa is enabled by default with no
config edit — the steward pattern (this repo's tumwater.json omits it; loadConfig merges per-role
defaults for absent ids). Catalog order: right after `perf`, so validation outranks general
improvement and the steward in tie-breaks. Two deliberate deviations from the plan's letter, both
recorded here rather than forced: the flow menu is derived from the README usage block (cheap
first) instead of a hardcoded list — the catalog ships with every project, and for tumwater itself
that yields init → status → logs → prompt → reset-counters → gui → tui → run; and enabling rides on
defaultConfig instead of a tumwater.json edit (loop rules forbid touching it). Remaining against
the acceptance criteria: dogfood observation only — a planted doc/behavior mismatch discovered
within a few qa ticks, and no orphaned processes after its ticks. Files: src/roles.ts,
src/config.ts, test/qa-role.test.ts (new), test/config.test.ts, README.md.

### Show timestamp of last result in the GUI/TUI live table (planned 2026-08-21, refined
2026-08-25, done 2026-08-26)

Both dashboards now show when a loop's last tick ended as an absolute local wall-clock time,
not only relative age. TUI/one-shot status: the existing `last tick` cell (no new column) shows
both — zero-padded local `HH:MM:SS` first, relative age after (`14:32:05 · 3m ago`), prefixed
`MM-DD ` once older than a day so multi-day runs stay unambiguous; loops that never ticked show
`-`. The formatter is the exported `lastTickCell` in src/status-render.ts. GUI: the loop table
gains a `last tick` column between cost and last result, rendered client-side from the payload's
existing `l.lastTickEndedAt` by a small JS helper mirroring the same format rules (`-` when null)
— formatting at each surface per the fmtTokens precedent. Width contract as planned: `last tick`
is the third flexible column, shrunk last (after `last result`, then `state`) with minWidth 10
(a bare HH:MM:SS), so on a narrow terminal it loses " · 3m ago" before whole lines clip and the
absolute time survives. Tests: cell format (recent / multi-day / never-ticked) plus an integration
row check; a three-stage narrow-width case with a work-item-style wide state cell proving the
shrink order last result → state → last tick down to their minimums, and no-wrap at 80 cols;
GUI page header + client-side render assertions. Files: src/status-render.ts, src/gui-page.ts,
test/status-render.test.ts, test/gui.test.ts.

### PRINCIPLES.md — positive design principles injected into every prompt (planned 2026-08-24,
done 2026-08-26)

Every project now carries a tracked `PRINCIPLES.md` — the codified answer to "what would a senior
engineer on this team always do," phrased as positive principles (per HN/chermi: LLMs follow
positive constraints far better than prohibitions). `initProject` seeds it beside PLANS/BUGS
(never clobbering an existing one; committed with the init commit) with a header stating the write
policy and four starter principles. `readPrinciples(root)` (src/prompt.ts) reads it fresh on every
tick — missing or unreadable file yields "" so prompt building never throws — capping the text at
4,000 chars with a truncation note so a runaway file cannot blow up every prefill. Both
`buildTickPrompt` (new optional `principles` field) and `buildDirectorPrompt` (third arg) inject it
verbatim in a `<principles>` block introduced as "design principles this project holds — uphold them
in everything you produce", placed right after the shared preamble; the block is omitted entirely
when empty. COMMON_RULES gains the write policy: only the director and steward may edit
PRINCIPLES.md, every other loop treats it as read-only and records objections in PLANS.md instead
(QUESTIONS.md does not exist yet — that plan owns the outbox channel). The director's routing block
now points standing design guidance at PRINCIPLES.md first, README/PLANS/BUGS otherwise; the readme
role's find text explicitly excludes PRINCIPLES.md from its drift-fixing remit. This repo is
self-hosted: it carries its own PRINCIPLES.md (zero runtime deps, offline fake-pi tests, harness owns
all git ops, opinionated defaults over configuration, one focused change per tick). README's "How it
works" documents the seeding and injection. Tests: init seeding/clobber/commit; readPrinciples
missing-file and cap-clipping; verbatim `<principles>` injection in both builders plus omission when
empty; COMMON_RULES write policy; director routing text; readme role remit. Files: src/init.ts,
src/prompt.ts, src/roles.ts, src/loop.ts, PRINCIPLES.md (this repo), test/init.test.ts,
test/prompt.test.ts, README.md.

### Show open bugs and planned features in the TUI/GUI (planned 2026-08-24, done 2026-08-26)

Both dashboards now surface project status — what the fleet is working toward — not just loop
status. `src/backlog.ts` owns reading and parsing: `parseEntries(md, sectionTitle)` returns the
`### ` heading texts inside one `## <section>` only (stops at the next `## `, so Done/Fixed never
leak in; body text ignored; `_None yet._` placeholders skipped; full heading kept including any
`(planned …)`/`(reported …)` suffix), and `plannedPlans(root)` / `openBugs(root)` read PLANS.md's
`## Planned` and BUGS.md's `## Open` fresh on every call — missing or unreadable file yields `[]`,
never throwing into a render path. TUI: the Ctrl+T activity pane gains a project status view after
the per-loop transcripts (cycle math now `view % (roleIds.length + 2)`, stale-index clamp updated);
same slot and height budget as recent activity, body keeps the *head* of the list when it overflows
(file order is newest-first, unlike events which keep the tail), header `project status — Ctrl+T to
cycle`. GUI: `/api/status` carries `plans`/`bugs` (fresh per poll) and the page renders a project
status panel below the loop table styled like #feed/#transcript — *planned features (N)* and *open
bugs (M)*, `(none)` when empty; no count badge on the status header line (the Questions outbox plan
owns that spot). One deviation from the plan: `backlogLines` (the TUI body-line formatter) was moved
from src/backlog.ts into its sole consumer, tui.ts, by a later organize pass — backlog.ts now owns
only reading and parsing. Tests: parser section isolation / missing files / placeholders / body-text
leakage; fresh-read visibility of edits; GUI payload fields and the served page panel. Files:
src/backlog.ts, src/tui.ts, src/gui.ts, src/gui-page.ts, test/backlog.test.ts, test/tui.test.ts,
test/gui.test.ts.

### Show current work item per active loop in the GUI/TUI tables (planned 2026-08-25, done 2026-08-25)

Both dashboards now show what each working loop is doing at a glance. `LiveProgress` gains
`currentWork`, captured in feedLine from the first non-empty assistant text block of the current
run — whitespace-collapsed and truncated to ~60 chars with an ellipsis; reset on every `session`
event, so thinking/tool-call-only runs stay unset until some message carries text (renders `-`).
TUI/one-shot status: the table's state cell prepends it while a tick is in flight (`implement
plan X · working 3m · turn 2`) — prepending so the item survives ellipsis clipping on narrow
terminals; idle loops are untouched, so a finished tick's item never lingers. GUI: `/api/status`
carries `currentWork` per loop (from readLiveProgress when running, else null) and the loop table
gains a `current` column right after state (`-` when null). One deliberate deviation from the
plan: the prepend happens at the renderStatus row level rather than inside workingDetail — the
GUI's state cell already renders workingDetail via phase, so prepending there would have shown
the item twice in adjacent columns. Tests: progress capture/reset/collapse/truncation/no-text
cases; renderStatus prepend + no-leak + narrow-width clipping (item head survives); payload field
for running-only loops and the page column header. Files: src/progress.ts, src/status-render.ts,
src/gui.ts, src/gui-page.ts, test/progress.test.ts, test/status-render.test.ts, test/gui.test.ts.

### CLI subcommand to reset loop counters — ticks, commits, tokens, cost (planned 2026-08-25,
refined 2026-08-25, done 2026-08-25)

`tumwater reset-counters [--role <id>]` zeroes the per-loop ticks/commits/tokens/cost for a fresh
observation window without touching scheduling or pi session continuity. The CLI zeros each
target's state file directly (works while the harness is not running; `--role` validated against
`allRoleIds()` like `logs --role`, unknown role fails with no side effects) and drops a marker at
`.tumwater/reset-counters.json`; the orchestrator consumes it in its existing poll cycle — calling
a new public `LoopRunner.resetCounters()`, backed by the pure `zeroCounters` helper in src/state.ts
that zeroes exactly ticks/commits/generatedTokens/totalCostUsd, preserves nextRunAt/
backoffSeconds/lastMainHead/hasSession/consecutiveErrors and the last-result fields, and
deliberately keeps the peakContextTokens high-water mark — then logs one plain `counters_reset`
event (filed under the role for a single target, harness-level with a roles list otherwise) and
deletes the marker. A corrupt marker resets every runner (idempotent superset). End-to-end test
drives the real orchestrator: counters zero on disk after consumption, stay zeroed across tick
boundaries (no resurrection from a stale in-memory save), and the reset appears as one event;
CLI-level tests cover file zeroing, marker contents, `--role` targeting, and clean failures.
Files: src/paths.ts, src/state.ts, src/cli.ts, src/orchestrator.ts, src/loop.ts, src/types.ts,
src/event-format.ts, test/state.test.ts, test/cli.test.ts, test/orchestrator.test.ts,
test/event-format.test.ts, README.md.

### Live-reload tumwater.json while the harness is running (planned 2026-08-23, done 2026-08-25)

The orchestrator's poll cycle now reloads `tumwater.json` once per cycle through a new
non-throwing `loadConfigSafe` (src/config.ts). On success the fresh config is pushed into every
runner (`LoopRunner.config` is assignable, src/loop.ts), so provider/model/thinking/instructions,
tick intervals, and backoff steer subsequent ticks within ~2s with no restart; a role enabled
mid-run gets a new `LoopRunner`, and `isEligible` refuses disabled roles so they stop ticking
immediately while re-enabling resumes within one cycle (runner and persisted state survive). A
broken file keeps the last-known-good config, logs exactly one `warning` per distinct error text
(no 2s spam), and recovers silently once fixed; role enable/disable transitions log a one-shot
warning. End-to-end tests drive the real orchestrator with a fake pi that records its argv:
mid-run model edits reach pi's `--model`, ticks continue under a broken file, recovery applies
the fix, and disabling/enabling roles starts/stops their loops without restart; unit tests cover
`loadConfigSafe`'s success/error shapes. README documents live vs restart-only settings
(`maxConcurrent`, `sessionRetentionDays`). Files: src/config.ts, src/orchestrator.ts,
src/loop.ts, test/orchestrator.test.ts, test/config.test.ts, README.md.

### Linear history on main: rebase instead of merge commits (planned 2026-08-24, done 2026-08-25)

Work now lands on main via **rebase**, not merge, so main's history stays linear going forward.
The sync primitives in src/git.ts are rebase equivalents of the old merge ones (shared
`attemptRebase` classifier): `rebaseOntoMain`, `rebaseOntoMainLeaveConflicts`, and
`continueRebase` (`git add -A` + `GIT_EDITOR=true git rebase --continue`, so it can never block
on a commit-message prompt). A resolution that leaves no unique content (the branch's change was
fully superseded by main) is skipped automatically by git, finishing the rebase cleanly. A second
conflict — only possible when pi authored extra commits during the tick — aborts after the one
per-tick resolution attempt and reports `merge_conflict` as before; `resetWorktreeToMain` and the
generalized `abortSync` clear interrupted rebases so a killed tick cannot wedge later ticks with
"you are already rebasing". End-to-end tests assert main's history stays linear (`git log
--merges` does not grow) for both the pi-resolved-conflict and concurrent-main-advance paths, plus
unit tests for each primitive (no-op rebase preserves commit hashes, markers left in place,
empty-resolution skip, interrupted-rebase recovery). Files: src/git.ts, src/loop.ts,
src/prompt.ts, test/git.test.ts, test/loop.test.ts, README.md (one line).

### Surface per-role pi transcripts in the TUI/GUI (planned 2026-08-23, refined 2026-08-23, done 2026-08-24)

TUI: Ctrl+T cycles the activity pane between recent events and each loop's transcript (header
`transcript: <role> — Ctrl+T to cycle`), occupying exactly the same slot and height budget as
recent activity so the no-wrap invariant holds; the view index clamps when roles change, and an
empty log shows "(no transcript yet)". GUI: GET `/api/transcript?role=&n=` (unknown role or bad
n → 400 with a clear message; default n=50) plus a click-to-toggle transcript panel below the
loop table that re-fetches on the existing 1s poll and shows "(no transcript yet for this loop)"
when empty. Tests in test/gui.test.ts cover endpoint validation and parse every inline `<script>`
body so unparseable page JS can never ship silently (regression for a bare-`\n` template-literal
bug that blanked the dashboard). Files: src/tui.ts, src/gui.ts, src/gui-page.ts, test/gui.test.ts.

### Per-role pi transcript via `tumwater logs --role` (planned 2026-08-21, refined 2026-08-23, done 2026-08-23)

`tumwater logs --role <id> [-n N] [-f]` renders a loop's raw pi JSONL into readable transcript
lines: run separators stamped from the first user message of each run, one-line abbreviated
thinking (~80 chars), indented assistant text (capped at 4 lines per message), tool calls via
describeToolCall, and retry warnings; streaming deltas and multi-KB tick prompts are never
shown. `-f` follows the live log with byte-offset/watchFile, advancing only past complete
lines, so each turn prints exactly once when its `message_end` lands. New module src/transcript.ts
(pure formatter over JSONL lines + incremental renderer) tested in test/transcript.test.ts;
one-shot and follow both read through files.ts's shared `readCompleteLines`, which never
consumes a torn trailing line. TUI/GUI surfacing is recorded as its own plan.

### Totals row for tokens and cost in the status table (planned 2026-08-21, done 2026-08-21)

`renderStatus` appends a separator plus a `total` row summing tokens (compact-formatted) and cost
across loops; shared by the TUI and one-shot status. Tests in test/status-render.test.ts.

### Decompose requests into sub-plans/sub-bugs when routing (planned 2026-08-21, done 2026-08-21)

A single shared `DECOMPOSITION_GUIDANCE` constant (src/prompt.ts) is embedded in the director's
routing block and the plan/bugfix role prompts: independent subparts become separate
cross-referencing PLANS.md/BUGS.md entries; coupled work stays a single entry. Tests in
test/decompose.test.ts.

### Web GUI (done 2026-08-20)

`tumwater gui [--port N]` serves a zero-dependency browser dashboard on 127.0.0.1 (default
port 7180): loop table with live working detail, event feed, and a prompt box that queues to
the director. Reads the same `.tumwater/state` + `events.jsonl` files as the TUI, polling
every second. Files: `src/gui.ts`, `src/cli.ts`.

### pi-driven merge conflict resolution (done 2026-08-20)

On a merge conflict, the loop re-runs the merge leaving markers in place, asks pi to resolve
them (one attempt per tick, honoring both sides' intent), verifies no markers remain, and
concludes the merge; unresolvable conflicts abort cleanly as before. Files: `src/loop.ts`,
`src/git.ts`, `src/prompt.ts`.

### Per-role model/effort overrides (done 2026-08-20)

Each role entry in `tumwater.json` may set `provider`/`model`/`thinking`, falling back to the
top-level values — cheap models for mechanical roles, strong ones for feature/bugfix. Files:
`src/types.ts`, `src/config.ts`, `src/loop.ts`.

### Log rotation and session pruning (done 2026-08-20)

`events.jsonl` and per-role pi logs rotate to `<file>.1` past a size cap (`logMaxBytes`,
default 16MB); pi session files older than `sessionRetentionDays` (default 7) are pruned at
orchestrator start. Files: `src/events.ts`, `src/pi.ts`, `src/orchestrator.ts`.
