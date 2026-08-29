# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

### The right to refuse, and friction as a signal (planned 2026-08-24, refined 2026-08-25,
refined 2026-08-27, audited 2026-08-28)

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

### Self-explaining commit bodies (planned 2026-08-24, refined 2026-08-25, refined
2026-08-27, audited 2026-08-28)

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

### Questions outbox — loops that know when to ask (planned 2026-08-24, refined 2026-08-25,
refined 2026-08-26, audited 2026-08-28)

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

### Steward role — whole-system judgment on a slow clock (planned 2026-08-24, refined 2026-08-25,
refined 2026-08-27, audited 2026-08-28)

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

## Done

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
