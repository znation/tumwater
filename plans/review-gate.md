# Adversarial review gate before merge

Planned 2026-08-24 · refined 2026-08-25 (failure handling, crash path, exemption semantics,
state plumbing; stale file refs after the status-layer split; combined-diff review for resumed
ticks) · refined 2026-08-27 (reviewer model override moves to the top-level `review` section —
role validation rejects pseudo-role ids) · refined 2026-08-28 (deterministic build pre-check —
feature tick 49's landing broke main's build with the gate active, exposing that the reviewer
cannot compile) · refined 2026-08-28 (build pre-check disambiguated and unblocked — worktree
node_modules walk-up, npm-ENOENT handling; main's build green again since `c02189c`) · from the
"Senior Tumwater" report (HN 49421554) · report item R1

## Status (plan-loop audit 2026-08-27, re-audited 2026-08-28, re-audited 2026-08-29)

**All five remaining items from the 2026-08-27 audit are landed and verified** — feature tick 47
(`74224e9`) wired the gate into the main tick path; checked at `97e3e94` with a green build and a
324/324 suite:

1. Main tick path: `runTick` calls the gate after `commitAll`, before `merge`; full GateResult →
   outcome mapping (`aborted` re-queues a director prompt; reviewer usage folded via `foldUsage`).
2. `"rejected"` schedules like `"changed"` (backoff reset, next tick at minTickInterval, no commit
   counted); `"review_error"` takes error backoff.
3. `state.phase` clears at tick end — except on abort, deliberately: an aborted mid-review tick
   must recover and re-review fresh instead of resuming the author session whose work is committed.
4. test/review.test.ts (renamed from review-gate.test.ts) covers the pure functions plus gate
   orchestration: approve + stray-edit discard, reject reset + reasons recorded, verdict-less
   fail-closed keep, 3-strike discard, doc-only exemption without a pi run, `enabled: false`
   no-op, `lastApprovedHead` skip, `-recovery` session suffix, abort with no bookkeeping;
   loop.test.ts routes fresh/resumed/recovered ticks through the gate.
5. All four review event types render in formatEvent; status shows `reviewing <elapsed>` while
   under review and suppresses the reviewer's own live detail from the work-item cell.

Remaining — all test work: the pre-check's suite plus items (b)–(c), nothing structural:
(a) Landed since this audit: coverage tick `8ea49b8` added the tick-level e2e (a rejected
change's reasons appear in the role's next prompt); unit tests for `buildRejectedReviewNote`
are in test/prompt.test.ts.
(b) "the merge lock is not held during review" is structurally true (the gate runs before
`withLock`) but untested — two fake-pi loops, one under review while the other merges.
(c) The `reviewing <elapsed>` state cell has no test in status-render.test.ts.
(d) Landed since this audit: feature tick 54 (`93d14f5`, audited by the plan loop 2026-08-29 at
`fda67b8`) implemented the full design in src/review.ts — `detectBuildCheck` (walk-up to the
nearest package.json + node_modules, typecheck preferred over build, total and never-throwing),
`runBuildCheck` (execFile `npm run <script>` with cwd = worktree; 300 s cap exposed as the
buildCheckTimeoutMs test seam on ReviewContext), and outcome routing in reviewAheadOfMain exactly
per the section below — deterministic reject through the existing reject path with no pi run
consumed, timeout/no-npm warn-and-proceed. The dogfood mechanism was exercised end-to-end during
the audit: from a worktree with no local install, detection resolves the main repo root three
levels up and `npm run build` compiles the worktree's own sources (tsc resolved by walking up to
the root's node_modules) into the gitignored dist/, tree left clean. One recorded deviation:
machine-generated reasons join the header to the first output line so the compiler error sits
right after `build check failed (<script>):` in the injected next-tick note. Bugfix tick 58
(`038519a`) landed part of that suite — runBuildCheck units (toolchain resolution from the
installed root when the worktree has no node_modules; failing build → failed + clipped tail;
timeout → skipped), the detectBuildCheck walk-up unit, and a gate e2e proving a passing pre-check
reaches the reviewer; improve tick `36b0adc` then removed 038519a's PATH-prepend workaround (npm's
own run-script walks up ancestor node_modules/.bin dirs — no env manipulation needed), with the
resolution test pinning that. What remains: the uncovered detection edge cases, the no-npm branch,
clipBuildTail units, and the failing/hanging gate e2e — full spec under PLANS.md's corrected
2026-08-29 re-audit. Items (b)–(c) are unaffected and independently pickable.

The dogfood `tumwater.json` review section remains optional — defaults already enable the gate; a
strong-model override is a user decision.

## Goal

No diff reaches main unreviewed. After a loop commits its tick, an independent pi run — a fresh
session with no author context — reviews the diff against PRINCIPLES.md and either approves it for
merge or rejects it with reasons. Rigor is calibrated to blast radius: doc-only diffs skip the
gate; code diffs get the full adversarial pass. The invariant is *structural*: every path that can
move a commit into main — a fresh tick's merge, a resumed tick's merge (which lands leftover
commits from an interrupted run), and `recoverLeftover`'s salvage — reviews the full ahead-of-main
diff first, so no crash or abort path can smuggle unreviewed work in.

## Motivation

HN commenter **BatFastard** keeps a 60k-LOC agent-built project grounded with "antagonistic agent
code and architecture reviews"; **izzydata**/**wek** argue verification is where engineering
expertise actually lives; **Ancapistani** says the senior skill is calibrating review rigor.
Tumwater has already paid for the gate's absence twice: a killed tick force-merged a syntactically
broken GUI page, and half-done feature work landed silently.

## Design

### Placement (`src/loop.ts`)

In `runTick`, after `commitAll` and before `merge()`. The reviewer runs in the author's worktree
(post-commit, so it can read the full tree); the harness hard-resets any stray working-tree edits
the reviewer makes before merging — the reviewer's only output channel is its verdict.

- **Outside the merge lock.** Review happens before `merge()` acquires the shared merge lock, so
  other loops keep merging while one loop is under review (a review run can take minutes).
- **Budget:** the reviewer reuses `runPi` with the same signal and quiet watchdog; give it its own
  timeout of `tickTimeoutSeconds`. Worst-case tick duration becomes 2 × `tickTimeoutSeconds`
  (author + reviewer) — the same order as today's transient-retry worst case.

### Reviewer run (`src/pi.ts` reuse)

`runPi` with a *fresh* session every time: no `--continue`, and because pi is launched with
`-n <sessionName>` when not continuing, use a **unique name per run** —
`tumwater-review-<role>-<tick>`, mirroring the author runs — under sessionDir
`.tumwater/sessions/_review/<role>/`. (A fixed name would let pi resume an old review's context;
old files are cleaned by the existing age-based prune at orchestrator start.) Model/thinking come
from optional `provider`/`model`/`thinking` fields on the new top-level `review` section (see
Rigor calibration), resolved over the top-level values by a small accessor mirroring
`configForRole`'s fallback pattern — so the strong model can review what the cheap model wrote.
Do NOT use a pseudo-role entry in `roles`: config validation rejects ids outside `allRoleIds()`
(`roles.review is not a known role (valid ids: …)`), so such an entry would fail tumwater.json
load (live-reload keeps last-known-good and warns; the override silently never applies) — and
even if it were accepted, enabling it would spawn a runner whose `tickPrompt` throws on every
tick (no catalog entry). One top-level section keeps all gate settings together.

### Prompt (`src/prompt.ts`)

New `buildReviewPrompt(diff, summary, commitBody, principles)`. Instructions: adversarial stance —
hunt for correctness bugs, principle violations, complexity growth, incomplete work; read
surrounding code freely; do not edit anything; end with exactly `VERDICT: approve` or
`VERDICT: reject` followed by numbered reasons. Diff comes from the **combined ahead-of-main
diff** `git diff <main>...<head>` — everything this merge will land, not just the newest commit —
capped (~200 KB; over the cap, send `--stat` plus the largest files and note the truncation — an
oversized diff is itself reviewable information). For a clean fresh tick that equals the new
commit's own diff (`git show <commit>`); for a resumed or recovered tick it also includes leftover
commits from an interrupted run (see crash path below). **Verdict parsing:** scan the run's assistant text (any message,
like the nothing-to-do sentinel) for the last `/^VERDICT:\s*(approve|reject)/m`; anything else is a
failed review, not an approval.

### Rigor calibration (`src/types.ts` + `src/config.ts`)

A top-level `review` section: `{ enabled: true, exemptPaths: ["*.md", "docs/**"] }`, plus
optional `provider`/`model`/`thinking` strings (validated like the role-entry string fields)
that a small accessor resolves over the top-level values — mirroring `configForRole`'s fallback,
but standing alone so no role-validation, catalog, or runner-spawning code changes. The reviewer
run passes that resolved config to `runPi`. A diff whose files all match `exemptPaths` merges
without review; a diff with even one non-exempt file gets the full pass.
(Refusal notes and QA bug reports are md-only, so they stay cheap by construction.)

**Exemption semantics** (small pure helper, e.g. `isExemptPath(relPath, patterns)` in
`src/review.ts`, unit-tested): a pattern containing no `/` matches the file's **basename** at any
depth (`*.md` exempts `docs/notes.md` too); a pattern containing `/` matches the full repo-relative
path, where `*` matches within one path segment and `**` across segments (`docs/**` = everything
under `docs/`). Exemption is per-diff: *every* changed file in the commit must match some pattern.

### Deterministic build pre-check (`src/review.ts`) — refined 2026-08-28

The gate as built can only judge what it can see, and its reviewer is forbidden from running any
state-changing command ("no writes anywhere") — but `npm run build` *is* exactly that
(`rm -rf dist && tsc`). Type errors are therefore invisible to the model review: broken work has
landed on main five times, and the first landing with the gate active (feature tick 49, open in
BUGS.md) got through precisely this hole. Fix it structurally — the same spirit as "all git
operations belong to the harness": a check whose correctness must not depend on model compliance
is run by the harness, not asked of the reviewer.

- **Placement:** inside `reviewAheadOfMain`, after BOTH early returns — the already-approved-HEAD
  skip and the exemption short-circuit (an md-only diff cannot break the build and merges with no
  check at all) — and before `logEvent(review_start)` / `state.phase = "review"` / the reviewer's
  pi run, so a deterministic rejection never shows as "reviewing" on the dashboards. Both gate
  callers (the tick path and `recoverLeftover`) get it for free.
- **Command detection** (pure helper, no config knob — one sensible way): find the project root by
  walking UP from the worktree — at most five levels — to the nearest ancestor directory that
  contains BOTH a `package.json` and a `node_modules/` directory; read scripts from THAT file. The
  walk is required, not optional: tumwater's own worktrees live at `<repo>/.tumwater/worktrees/<role>`
  with no install of their own (node_modules is gitignored — it exists only where someone ran npm
  install, i.e. the main repo root), so a literal `<wt>/package.json` + `<wt>/node_modules` check
  would silently disable the pre-check forever in dogfood. When both hold at one level: prefer
  `scripts.typecheck`, else `scripts.build`; neither → no check (the model review still applies;
  non-JS projects are untouched in v1). No qualifying ancestor within five levels, or a missing/
  unreadable/malformed package.json → no check — detection never throws into the gate.
- **Execution:** `npm run <script>` via `execFile` with cwd = worktree (the same spawn pattern as
  git.ts), combined stdout+stderr captured, hard cap 300 s (module constant; a parameter of the
  helper so tests can shorten it). Running a local script needs no network. Tests stay offline per
  PRINCIPLES: a scratch dir with a package.json (`"build": "node -e 'process.exit(2)'"` etc.) plus
  an EMPTY `node_modules/` directory is enough — npm resolves the script without any install.
- **Outcomes:** exit 0 → proceed to the reviewer run unchanged. Nonzero exit from a started
  process → a review REJECTION with machine-generated reasons — `build check failed (<script>): …`
  plus the clipped output tail — routed through the existing reject path verbatim (`resetWorktreeToMain`,
  `state.lastReview`, `review_rejected` event, next-prompt injection via
  `buildRejectedReviewNote`); no pi run is consumed (`GateResult.run` absent, as on exempt) and
  `unreviewFailures` resets exactly like a model reject — a deterministic verdict about this HEAD.
  The author's next tick sees the compiler lines and fixes them. Timeout — or a spawn ENOENT where
  the `npm` binary itself is missing — is environmental, not the author's fault: one `warning`
  event ("build check timed out after Ns; proceeding to model review" / "no npm on PATH; skipping
  build check") and the reviewer run proceeds — deliberately NOT fail-closed, so a hung build script
  (watch mode) cannot wedge every code tick into the 3-strike discard of good work. Accepted cost:
  while such a script hangs, every code tick pays the cap before its model review.
- **Output clipping:** keep the TAIL of the combined output — last ≤10 non-empty lines, each via
  the existing `clipReason` (300 chars) — so a chatty build cannot bloat persisted state or the
  injected note. Stray working-tree edits from the check are already cleaned by both downstream
  paths: reject → `resetWorktreeToMain`; approve → the existing post-approval `git reset --hard
  HEAD`.

### On approve

Proceed to the existing merge path unchanged; record `lastApprovedHead` (the reviewed branch HEAD)
in LoopState — see crash path below.

### On reject

Do not merge. Reset the branch to main (work discarded), log a `review_rejected` event carrying the
reasons, store them in `LoopState.lastReview`, and inject them into the role's next tick prompt
("your previous change was rejected in review: … — address the objections or take a different
approach"). Every tick now starts a fresh pi session (cross-tick `--continue` was removed), so this
injection is the *only* cross-tick memory of what was built and why it failed — keep it complete.
New
`TickResult` value `"rejected"` rendered in status/GUI. Scheduling: treat like `changed` (reset
backoff, `nextRunAt = now + minTickIntervalSeconds`) so the author addresses the objections on its
next eligible tick rather than sleeping through them; repeated rejects stay visible via events.

### On review failure (no parseable verdict, pi error, or timeout) — fail closed, retry next tick

Do not merge **and do not reset**: leave the commit on the branch and end the tick with a new
`TickResult` `"review_error"` (rendered like an error; backoff as for errors). The work is intact
on the branch, so the *next* tick's `recoverLeftover` re-reviews it — a transient model-server
failure self-heals without losing work. **Bounded:** track consecutive review failures per HEAD in
LoopState (`unreviewFailures`, reset when the reviewed HEAD changes or a review succeeds); after 3,
discard the leftover (reset branch to main) with a `warning` event — a misconfigured reviewer model
cannot wedge a loop into re-reviewing the same commit forever.

### Crash path: recovery and resume both route through the gate

Two paths can carry an interrupted tick's committed work into main without review. (1) A *fresh*
tick starts with `recoverLeftover`, which today merges any commits ahead of main blindly. (2)
Since the interrupted-tick resume landed, a tick killed after `commitAll` is resumed on next
launch — and a resumed tick **skips** `recoverLeftover` entirely: it continues in the same worktree
with the leftover commits still ahead of main, and its own merge (rebase + fast-forward lands
*everything* ahead of main) would carry them in unreviewed alongside whatever new commit gets
reviewed. Fix both at once: because the gate reviews the combined `git diff <main>...<head>` (see
Prompt), any path that merges a branch head has already reviewed everything it will land; and
`recoverLeftover` no longer merges blindly. When leftovers exist:

1. If the leftover HEAD equals `lastApprovedHead`, merge directly — already reviewed; this is what
   a `merge_blocked` retry hits and must not burn another review run.
2. Otherwise run the same reviewer over the combined leftover diff (`git diff <main>...<head>`,
   capped as above): approve → record `lastApprovedHead`, then merge (existing summary); reject →
   reset + record reasons exactly like a tick reject; fail → leave for retry under the 3-strike cap.

This makes the invariant structural: every path that can move a commit into main (fresh merge,
resumed-tick merge, recovery merge) has reviewed the full ahead-of-main diff first. Note the prompt is
built before recovery in `runTick`, so reasons recorded during this tick's recovery surface on the
*following* tick — acceptable, say nothing cleverer. Leftovers are rare (crash/abort/reject only),
so the extra reviewer run costs nothing in steady state.

### Director ticks

Not exempt by role: a director diff touching non-exempt paths is reviewed like any other (director
ticks are usually md-only → exempt by construction). No special-casing.

### State and dashboard plumbing (`src/types.ts`, `src/status-render.ts`)

- `LoopState` gains optional fields: `phase?: "pi" | "review"` (set + saved around the reviewer
  run, cleared at tick end alongside `running`), `lastReview?: { verdict: string; reasons: string[];
  head?: string; at: number }`, `lastApprovedHead?: string`, `unreviewFailures?: number`.
- `loopPhase`/`workingDetail` (src/status-render.ts — the presentation layer; status.ts only
  collects snapshots and passes loop fields through unchanged): when `s.running && s.phase ===
  "review"`, render `reviewing <elapsed>` instead of the pi live detail. No changes to gui.ts or
  gui-page.ts: `statusPayload` already calls `loopPhase` for the GUI's state cell, and new result
  values flow through as plain strings via `lastResult`/`lastSummary`.
- New outcomes `"rejected"` / `"review_error"` rendered in the status table and GUI like other
  results (with reason/summary text).

### Observability

`review_start` / `review_verdict` events (verdict event carries approve/reject + first line of
reasons); `review_failed` on unparseable/failed runs; reviewer tokens/cost fold into the loop's
totals (`generatedTokens`/`totalCostUsd`). The new event types join the `HarnessEvent.type`
union (src/types.ts) and get plain rendering in `formatEvent` (src/event-format.ts — it no longer
lives in src/events.ts).

## Files touched

`src/loop.ts`, `src/prompt.ts`, `src/types.ts`, `src/config.ts` (review section + validation + model-override accessor),
`src/review.ts` (new: exemption matcher, verdict parsing, build pre-check + detection,
review-run orchestration shared by the tick and recoverLeftover paths), `src/status-render.ts` (`loopPhase`/`workingDetail` reviewing
state — not src/status.ts), `src/event-format.ts` (review event rendering — formatEvent no longer
lives in src/events.ts), `tumwater.json` (dogfood: top-level `review` section with the strong-model override),
`test/review.test.ts` (renamed from review-gate.test.ts; fake-pi shim scripting both verdicts; review-section config
validation + accessor fallback over top-level values; exemption matcher unit tests — basename vs
path patterns, all-files-must-match; approve merges / reject resets + next-prompt
injection; review failure leaves commit and re-reviews next tick; 3-strike discard; recoverLeftover
reviews leftovers but skips `lastApprovedHead`; a resumed tick with leftover commits lands them only
via the combined-diff review; stray-edit reset; fresh session naming; build pre-check units —
detection walk-up / script preference / malformed → null, run outcomes pass/fail/timeout/no-npm,
tail clipping — plus gate e2e: failing scratch-repo build rejects with zero reviewer runs and its
compiler tail injected into the next prompt, passing build proceeds to the reviewer), README.

## Acceptance criteria

- A code diff only merges after a reviewer run ends `VERDICT: approve`; a reject leaves main
  untouched, resets the branch, records reasons, and the role's next prompt contains them.
- Md-only diffs (per exemptPaths) merge without a reviewer run; one non-exempt file in an otherwise
  md diff triggers review. Exemption matcher unit tests cover `*.md` at depth and `docs/**`.
- When the worktree's project declares a JS check, the gate runs it deterministically before any
  model review: a failing `npm run <script>` rejects through the existing reject path with the
  compiler tail as reasons (branch reset, `review_rejected` logged, zero reviewer pi runs); a
  passing one proceeds to the reviewer; a timed-out one logs a warning and still proceeds.
  Detection is pure and total — no qualifying ancestor within five levels (no package.json, no
  node_modules), neither script present, or malformed JSON all yield "no check" without throwing
  (unit-tested, including the dogfood shape: a worktree at `<repo>/.tumwater/worktrees/<role>`
  resolving the main repo root's package.json + node_modules).
- A failed/verdict-less review never merges: the commit stays on the branch, the tick ends
  `review_error`, and the next tick's recovery re-reviews it; after 3 consecutive failures for one
  HEAD the leftover is discarded with a warning.
- Simulated crash between commit and review (commit left ahead of main) does not land unreviewed:
  the next tick reviews before merging — whether it arrives as a fresh tick via `recoverLeftover`
  or as a resumed tick that skips recovery. An already-approved HEAD (`lastApprovedHead`) merges
  without re-review.
- Reviewer stray edits never reach main; reviewer runs use a fresh uniquely-named session each time;
  the merge lock is not held during review (another loop can merge concurrently — testable with two
  fake-pi loops).
- `review.enabled: false` restores today's behavior exactly. Status/GUI show `reviewing` while a
  pass runs and render `rejected`/`review_error`. `npm test` passes.

## Dependencies & sequencing

Wants [principles.md](principles.md) first (the review standard). The refusal plan's md-only
objection notes and the commit-body plan's structured messages both feed the reviewer richer
context but are not prerequisites.

## Out of scope

Reviewing merges of main into loop branches (conflict resolution keeps its existing verifier);
multi-reviewer quorums; human review checkpoints.
