# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.


## Planned

### Role notebook: carry a bounded, model-written note per role across fresh ticks (planned 2026-10-06 by operator; evaluate with the tick_end prompt-token fields above, so land that plan first)

Context: the 2026-10-06 analysis recorded a decision to keep a fresh pi session per tick, for
three reasons.
- Replaying the fleet with each tick carrying its predecessor's context costs 2.0× the prompt
  tokens raw, or 1.7× compacted to ~23k (pi's `keepRecentTokens` 20k plus a summary).
- Carried file views go stale: the worktree resets to main each tick, and other loops land
  in between.
- Fresh ticks are what retired session poisoning (1046112).

The continuity worth keeping is small: 25% of what a role reads is a file it also read in its
previous tick, and each tick re-derives the same codebase facts. omp's experimental
notes-backed context (`compaction.experimentalContextManagement`: a 16 KB `context_notes`
notebook plus `new_context` rollover, no summarizer) is the same design. This plan gives each
tumwater role that notebook, with the tick boundary serving as the rollover.

**Goal.** At tick start, each role loop sees a short note written by its own earlier ticks:
codebase facts, dead ends, and where its search stands. The loop can replace the note before
ending. No transcript is carried.

**Approach.**
1. **`src/paths.ts`** — `roleNotesPath(root, role)` → `.tumwater/state/notes/<role>.md`.
   This is runtime state that is never committed, like `qaCoveragePath`.
2. **`src/pi-extension/role-notes.ts`** (new bundled extension) — registers a `role_notes`
   tool (`text: string`) through `pi.registerTool()`, but only when `TUMWATER_NOTES_PATH` is set
   in the environment.
   - The tool replaces the file at that path with `text`, writing to a temp file and renaming.
   - Text over 4,096 UTF-8 bytes is rejected with an error that names the limit, and nothing
     is written.
   - Empty text clears the note.
   - The validation is a pure exported function, so it is unit-testable without pi, the same
     pattern as bounded-output and context-budget.
3. **Wiring.**
   - `src/pi/pi-args.ts` adds `role-notes.js` to `bundledExtensionPaths()`.
   - The authoring runs in `src/loop/loop-pi.ts` (`runRolePi`, including resumes) set
     `TUMWATER_NOTES_PATH=roleNotesPath(root, role)` in the child env, beside the existing
     run marker (`src/pi/pi.ts`).
   - Review, landing and conflict-resolver runs leave it unset, so the tool never registers
     there.
   - The director gets no notebook: its work is the operator's prompt, not a recurring search.
4. **`src/tick/tick-prompt.ts` + `src/prompt/prompt.ts`** — `buildTickPrompt` takes an
   optional `notes` input, read from `roleNotesPath`; a missing, empty or unreadable file
   means no block. The block reads:
   "Notes your role wrote in earlier ticks (yours, unverified — check against the code before
   relying on them): <role-notes>…</role-notes>. Before you end, if you learned something the
   next tick of your role should know (where things live, what you ruled out and why, what you
   would look at next), call role_notes with the full replacement note (at most 4 KB). Do not
   copy backlog entries into it — PLANS.md and BUGS.md hold the work itself."
5. **`src/roles/role-view.ts` / `src/roles/role-render.ts`** — `tumwater role <id>` shows the
   current note, so the operator can read what each role believes.
6. **docs/how-it-works.md** — one paragraph: what the notebook is, where it lives, its size
   cap, and that it is the only state carried between a role's ticks besides the repo itself.

**Evaluation (operator, after 7 days on).** Use the tick_end fields from the plan above to
compare, for the 7 days before and after: each role's median `preEditPromptTokens`, its share
of ticks that never edit, and its prompt tokens per landed change.
- Keep the notebook if those numbers fall.
- Otherwise remove it (the extension, the prompt block and the path). The note costs up to
  ~1k tokens on every turn, so it must pay for itself.

**Files touched.** src/paths.ts, src/pi-extension/role-notes.ts (new), src/pi/pi-args.ts,
src/pi/pi.ts, src/loop/loop-pi.ts, src/tick/tick-prompt.ts, src/prompt/prompt.ts,
src/roles/role-view.ts, src/roles/role-render.ts, docs/how-it-works.md, and tests
(test/role-notes.test.ts (new), test/pi-args.test.ts, test/prompt.test.ts, test/role-view.test.ts).

**Acceptance criteria.**
- Validation accepts 4,096 bytes and rejects 4,097 bytes with the limit in the error,
  writing nothing. Empty text clears the file.
- With fake pi, an authoring run's child env carries `TUMWATER_NOTES_PATH`, and review,
  landing and conflict-resolver runs' envs do not.
- A role's tick prompt carries the `<role-notes>` block when the file has content and omits
  it otherwise. The director's prompt never carries it.
- `tumwater role <id>` shows the note, or says there is none.
- `npm run test` green.

### Fallback-window shake: reclaim old tool output instead of only warning when a small-window model fills (planned 2026-10-06 by operator; matters once roles run on a fallback model with a ~127k–258k window)

Context: when a run fills its window, two things happen today.
- The context-budget extension (src/pi-extension/context-budget.ts) tells the model its fill
  level at 50/70/85% and asks it to wrap up.
- Past the window minus 16,384, pi compacts with an LLM summary that loses the run's reads.

On the 1M-window primaries neither fires: the largest fleet tick from Oct 2–6 reached 140k.
The oMLX fallback models have 127k and 258k windows, though, and the model-fallback plans
above will route roles there on provider failures. omp's `shake` compaction method reclaims
context without a model call: it replaces old tool results with recoverable references and
keeps the recent window intact. pi 1.0.0 has the primitive to do the same from an extension:
a `turn_end` handler can append persisted `context_edit` entries (pi docs: extensions.md,
session-format.md).

**Goal.** When a run crosses 70% of its window, its old bulky tool results are replaced with
short pointers the model can follow. The run can then finish its task instead of stopping
early or being summarized.

**Approach.**
1. **`src/pi-extension/context-shake.ts`** (new bundled extension, loaded after
   bounded-output and before context-budget) with a pure planner `shakePlan(messages, usage)`.
   - At or above 70% usage, it selects `read` and `bash` tool results that are older than
     the newest 20,000 estimated tokens and longer than 2,000 chars.
   - A bash result is replaced by `[elided by tumwater: N chars; full output in <path>]`. It
     reuses `details.fullOutputPath`, or else writes the full text with bounded-output's
     `writeFullOutput`.
   - A read result is replaced by `[elided by tumwater: N chars of <path>:<start>-<end>;
     re-read the range if you still need it]`.
   - It never selects edit or write results, error results, or the user prompt.
   - It returns an empty plan when it would reclaim fewer than 10,000 estimated tokens.
2. **Apply** — through a `turn_end` handler that returns `context_edit` replacement entries.
   These are persisted, so a `--continue` resume rebuilds the same context. First check the
   exact return shape against pi's exported `extensions/types.ts`. If `turn_end` cannot
   propose edits, apply the same deterministic plan in the request-local `context` event
   instead.
3. **Once per crossing** — shake at 70%, and again at 85% only if the first pass did not bring
   the run back under 70%. Already-elided results are never re-elided. Append one line to the
   next tool result, as context-budget does: "[tumwater: elided N old tool results (~K
   tokens); each pointer says where the full text is]".
4. **`src/pi-extension/context-budget.ts`** — refresh its header, which still describes pi
   0.87. Keep its 85% stop-reading note as the backstop.

**Files touched.** src/pi-extension/context-shake.ts (new), src/pi/pi-args.ts
(`bundledExtensionPaths`), src/pi-extension/context-budget.ts, test/context-shake.test.ts (new),
test/pi-args.test.ts.

**Acceptance criteria.**
- Planner tests:
  - Below 70%, the plan is empty.
  - At 70%, only results outside the newest 20k tokens and over 2,000 chars are selected.
  - Edit, write and error results are never selected.
  - A plan that reclaims under 10k tokens is empty.
  - An already-elided result is not selected again.
- A bash replacement names a full-output path, and a bash result without
  `details.fullOutputPath` gets one written. A read replacement names the range.
- With `contextWindow` 1,048,575 and fleet-sized contexts (≤140k), the extension plans
  nothing.
- `bundledExtensionPaths()` lists the extensions in the order bounded-output, context-shake,
  context-budget, followed by the role-notes extension once that plan lands.
- `npm run test` green.

### Revise rejected changes, part 1/2: a rejected change goes back to its author as uncommitted edits instead of being discarded (planned 2026-10-06 by operator)

Context: a 2026-10-06 audit of the review gate covered events.jsonl since 2026-09-22.
- **Volume.** Of about 2,070 landing attempts, 1,658 landed and 292 were rejected (14%).
  Rejected changes consumed about 21% of recorded authoring spend. The feature loop's
  rejection rate was 37%, about 44% of its authoring hours.
- **Fixability.** Each of the window's 301 rejections was labelled by hand. Of the 260 that
  were not build-check failures, 77% were fixable by a message fix, a BUGS/PLANS fix or a
  few-line code change. Only 32 said the change should not exist.
- **What happens instead.** The reject path discards the work. `reviewAheadOfMain`'s `reject`
  closure (src/review/review.ts) resets the branch to main, and `reviewPinnedChange`
  (src/landing/landing-core.ts) deletes the pin. The author's next tick gets only the reasons
  (`buildRejectedReviewNote`) and re-derives the whole change from scratch. Each rewrite tends
  to add new defects, and a fresh reviewer finds different ones:
  - feature's timed pause was rejected eight times between 09-25 13:35 and 09-28 04:11, a
    different bug each round, before it landed at 07:35;
  - plan 4a/7 was rejected five times on 09-22, and per-role prompts four times on 09-25;
  - 65 rejections were followed directly by another rejection.
- **The earlier fix.** BUGS.md "A review rejection is invisible to every loop-level alarm"
  (fixed 2026-10-01) bounded how often a role re-authors after rejections, but not what each
  attempt costs. Its own analysis noted each attempt "pays the full authoring price instead of
  a cheap correction".

Why the author revises and not the reviewer:
- The reviewer's only output channel is its verdict, so every byte that lands was judged by a
  run that did not write it.
- An in-slot build-fix run was tried and removed in 4e9bf7f1 ("Attribute a repeat gate-check
  failure through main's baseline instead of an in-slot fix run"). It held the landing slot for
  hours and never led to a landing.

A revision instead runs on the author's own slot at its normal cadence, and goes through the
full gate again. Check-failure rejections become revisions too. That covers the compile breaks a
clean rebase cannot see, such as organize's 10-05 23:26 TS2307: a file another loop had just
added still imported a module organize moved.

**Goal.** A rejected change goes back to its author for at most two revision rounds. The
author's next tick starts with the rejected diff re-applied onto current main as uncommitted
edits. It fixes the named objections or drops the change. Whatever it produces lands through
the normal gate.

**Approach.**
1. **Keep the commit.**
   - `src/paths.ts` gets `rejectedRefName(role)` → `refs/tumwater/rejected/<role>`.
   - In `reviewPinnedChange`'s `rejected` branch (src/landing/landing-core.ts), point that ref at
     the rejected head (`state.lastReview.head`) before the landing ref is deleted, so the
     object survives gc.
2. **Count rounds.**
   - `LandingEntry` (src/landing/landing-queue.ts) and `LandRequest` (landing-core.ts) gain
     `revisionRound?: number`, absent for a fresh change. On a rejection,
     `next = (req.revisionRound ?? 0) + 1`.
   - When `next <= REVISION_LIMIT` (2, a constant in a new `src/loop/revision.ts`), set
     `LoopState.revision = { sha, round: next, at }` (src/loop/loop-state.ts).
   - Past the limit, clear `revision`, delete the rejected ref, and log `exhausted` (step 7).
     The plain rejected note then says the change was rejected after its last revision.
3. **Re-apply at tick start.** In `LoopRunner.runTick` (src/loop/loop.ts), after
   `resetWorktreeToMain` and the red-main gate, and before `runRolePi`, call
   `applyRevision(wt, mainBranch, sha)` (src/loop/revision.ts) when all of these hold: `s.revision`
   is set, the role is not the director, and this tick dequeued no user request.
   - It runs `git cherry-pick --no-commit <merge-base>..<sha>`, leaving the edits uncommitted.
   - On a conflict it runs `git cherry-pick --abort`, resets to main, and returns false.
4. **Prompt.** When `s.revision` is set, src/tick/tick-prompt.ts skips `buildRejectedReviewNote`
   and runTick appends one note after the apply.
   - **The diff applied.** Append `buildRevisionNote(lastReview, round, REVISION_LIMIT)`
     (src/gates/gate-prompts.ts). It says:
     - this tick's one task is revising the change already in the worktree;
     - fix each numbered objection with the smallest edit that resolves it, and keep everything
       else;
     - rewrite the closing SUMMARY/WHY/RISK/VERIFIED block so it describes the whole change as
       it now stands;
     - for a build-check failure in a test the change does not touch that you cannot reproduce,
       say so in RISK and keep the change as is;
     - when an objection shows the change should not exist (its premise disproven, it
       duplicates main, it has no reachable benefit), end with the nothing-to-do sentinel
       instead.
   - **The diff did not apply.** Clear `revision`, delete the ref, and append today's
     `buildRejectedReviewNote` plus one sentence saying the rejected diff no longer applies to
     current main.
5. **Drop.** In `resolveTickVerdict` (src/tick/tick-verdict.ts), a revision tick
   (`revisionRound` carried in its context) whose reply declares nothing-to-do while the
   worktree is dirty:
   - resets the worktree to main, clears `revision` and deletes the rejected ref;
   - ends `no_change` and does not stage. Today a dirty worktree always stages.
6. **Stage.**
   - `stageTickLanding` (src/tick/tick-stage.ts) copies the tick's `revisionRound` onto the
     `LandingEntry`.
   - The tick clears `s.revision`, since the revision is now in flight.
   - When that landing lands, delete the rejected ref.
7. **Events.** One `revision` event: `action` (`"applied" | "conflict" | "dropped" |
   "exhausted"`), `round` and `sha`. src/events/event-format.ts renders it, `tumwater logs` shows
   it, and the digest can measure revision yield.

**Files touched.** src/paths.ts, src/loop/revision.ts (new), src/loop/loop-state.ts,
src/loop/loop.ts, src/landing/landing-core.ts, src/landing/landing-queue.ts,
src/tick/tick-prompt.ts, src/tick/tick-verdict.ts, src/tick/tick-stage.ts,
src/gates/gate-prompts.ts, src/events/event-format.ts. Tests: test/revision.test.ts (new), plus
cases in test/lander.test.ts, test/tick-verdict.test.ts, test/tick-stage.test.ts,
test/tick-prompt.test.ts and test/gate-prompts.test.ts.

**Acceptance criteria.**
- **Rejection.** A gate rejection of a fresh change sets `refs/tumwater/rejected/<role>` to
  the rejected head and `LoopState.revision.round` to 1. A rejection of a round-2 revision
  clears `revision`, deletes the ref and logs `revision` `exhausted`.
- **Apply.** The role's next tick starts with the rejected diff applied as uncommitted edits
  on a main that moved in an unrelated file, and its prompt carries the revision note instead
  of the plain rejected note.
- **Conflict.** When the diff conflicts with current main, the worktree is clean main,
  `revision` is cleared, the prompt carries the plain note plus the no-longer-applies sentence,
  and `revision` `conflict` is logged.
- **Drop.** A revision tick that replies nothing-to-do ends `no_change` with a clean worktree,
  no landing queued, and `revision` `dropped` logged.
- **Stage.** A revision tick that stages queues a `LandingEntry` carrying its `revisionRound`.
  That landing's rejection yields round 2, and its landing deletes the rejected ref.
- **Exclusions.** The director never revises. A tick that dequeued a per-role user request
  leaves `revision` untouched.
- `npm run test` green.

### Revise rejected changes, part 2/2: the re-review sees the prior objections and what the revision changed (planned 2026-10-06 by operator; requires part 1/2 landed and running)

Context: the same audit found reviews of one idea flip between rounds, because each reviewer
starts with no memory of the previous review.
- On 09-28, bugfix's 2464b72f was rejected only for a wrong test count. Its re-land, 612848d4,
  was then rejected for real bugs the first review had missed, such as `commandBuffersOutput`
  misreading `2>>`.
- On the core→ui digest move, one rejection implied the change could re-land once its records
  were fixed. The next rejected it as a rule violation.
- Feature's timed pause got a different set of objections in each of its eight rounds.

Once part 1/2 keeps the rejected diff, the reviewer can be shown which objections a revision
had to resolve and what it changed to resolve them.

**Goal.** When a landing is a revision (`revisionRound` ≥ 1), the reviewer gets two things:
- the prior review's numbered objections, with the instruction to check each one first (one
  left unresolved is a rejection on its own);
- the interdiff between the rejected version and the revision.

It still reviews the whole diff as usual.

**Approach.**
1. **`src/landing/landing-queue.ts`, `src/landing/landing-core.ts`.**
   - `LandingEntry` and `LandRequest` gain `priorReview?: { sha: string; reasons: string[] }`.
   - `stageTickLanding` (src/tick/tick-stage.ts) fills it from `state.lastReview` when the tick
     was a revision.
   - A recovery landing reads it back as absent, so an orphaned revision is reviewed like a
     fresh change.
2. **`src/git/git-diff.ts`.** Add `revisionInterdiff(wt, mainBranch, priorSha, head)`:
   - it runs `git range-diff <changeBaseRev(prior)>..<prior> <changeBaseRev(head)>..<head>`;
   - it applies `aheadOfMainDiff`'s cap and truncation note;
   - it never throws, and returns empty on any git failure, including a prior object that is
     gone. Part 1/2's rejected ref keeps the object alive until the revision lands.
3. **`src/review/review.ts`.** `reviewAheadOfMain` takes the optional prior review and passes it,
   with the interdiff, to `buildReviewPrompt`.
4. **`src/gates/gate-prompts.ts`.** `buildReviewPrompt` gains an optional `priorReview`
   parameter. Its block goes right after the author's commit body:
   - this change is revision N of one rejected in review;
   - the objections, numbered, and the interdiff;
   - every objection must be resolved, and an unresolved one is a finding by itself;
   - new findings must be concrete and verifiable, as always.

   The prompt keeps the literal "VERDICT:" exactly twice, because test/gate-prompts.test.ts
   derives the accepted forms from it.
5. **`src/events/event-format.ts`.** A revision's `review_start` carries `revision: N`, rendered
   as `review (revision N)`.

**Files touched.** src/landing/landing-queue.ts, src/landing/landing-core.ts,
src/tick/tick-stage.ts, src/git/git-diff.ts, src/review/review.ts, src/gates/gate-prompts.ts,
src/events/event-format.ts. Tests: test/gate-prompts.test.ts, test/review.test.ts,
test/tick-stage.test.ts, and a new test/revision-interdiff.test.ts.

**Acceptance criteria.**
- **Prompt.** With a prior review, `buildReviewPrompt` contains each objection, the interdiff
  and the resolve-first instruction. Without one it is byte-identical to today's prompt, and
  "VERDICT:" still appears exactly twice.
- **Interdiff.** On a scratch repo where a commit is rebased onto a moved main and then
  amended, `revisionInterdiff` shows only the amendment, not main's movement. A missing prior
  sha yields an empty string, not a throw.
- **Events.** A revision landing's `review_start` carries `revision`; a fresh landing's does
  not.
- **Recovery.** A recovery landing of a revision is reviewed without the prior block.
- `npm run test` green.

### Pre-queue self-check, part 1/2: run the gate's deterministic backlog checks before a tick queues, with one fix-up turn on the author's session (planned 2026-10-06 by operator)

Context: the gate's two deterministic backlog checks only run at landing time:
`falseFixReason` (src/verdict/fix-claim.ts) and `backlogStructureReason`
(src/backlog/backlog-structure.ts). By then the author's session is over, and a finding costs a
queue slot, a vet, and a rejection that discards the work.
- On 2026-09-23, bugfix got the same rejection seven times between 05:52 and 15:52, each a full
  author, queue and vet cycle. The reason each time was `md-only BUGS.md edit moves "Any reply
  that merely mentions TUMWATER_REFUSED…" to Fixed, but none of the symbols…`.
- From 09-23 to 10-02 the gate caught 13 of these phantom-fix moves.

Both checks read the worktree and the change's merge-base, so they can run at staging time. At
that point the authoring session can still be continued; `requestSummary` already uses that
moment to recover a missing SUMMARY.

**Goal.** Before a changed tick commits, the harness runs the gate's deterministic checks. If
any finding comes back, the author gets one bounded follow-up turn on its own session to fix it.
The change then commits and queues as it does today, and the gate still has the final say.

**Approach.**
1. **`src/tick/stage-check.ts` (new).** Add
   `stageCheckFindings(wt, mainBranch, exemptPaths): Promise<string[]>`.
   - `files = changedFiles(wt)`: the uncommitted changes, untracked files included.
   - It returns `backlogStructureReason(wt, mainBranch, files)` when that is set.
   - It returns `falseFixReason(wt, mainBranch, files)` when `isExemptDiff(files, exemptPaths)`
     holds, the same scope the gate applies it in.
   - It never throws; a check that fails yields no finding.
2. **`src/gates/gate-prompts.ts`.** Add `buildStageFixPrompt(findings)`:
   - it lists the findings as what the landing gate will reject;
   - it asks the author to fix them in the worktree and reply with the closing
     SUMMARY/WHY/RISK/VERIFIED block again, or to say in RISK why a finding is wrong;
   - it carries the tick prompt's no-git rule.
3. **`src/loop/loop-pi.ts`.** Add `requestStageFix(wt, findings)`, a sibling of
   `requestSummary`.
   - It runs `--continue` on the authoring session.
   - It has its own caps, e.g. a 600 s timeout with `SUMMARY_REQUEST_QUIET_S` quiet, and the
     shared transient retry.
   - It returns null when no resumable session exists.
4. **`src/tick/tick-stage.ts`.** In `stageTickLanding`, after the SUMMARY recovery and before
   `commitAll`, run `stageCheckFindings`. When it returns findings:
   - run one `requestStageFix`; an aborted run goes to `finishAbortedTick`;
   - re-extract the SUMMARY and body from the follow-up's reply when it has them, and re-run the
     check;
   - warn once with the counts before and after, e.g. `stage self-check: 1 finding — fixed by
     the follow-up turn` or `…; 1 still open, queued for the gate`;
   - commit and queue either way.

   `TickStageContext` gains `stageCheck` and `requestStageFix` callbacks, wired in
   src/loop/loop.ts the same way as `requestSummary`.

**Files touched.** src/tick/stage-check.ts (new), src/tick/tick-stage.ts, src/loop/loop-pi.ts,
src/loop/loop.ts, src/gates/gate-prompts.ts. Tests: test/stage-check.test.ts (new),
test/tick-stage.test.ts, test/gate-prompts.test.ts.

**Acceptance criteria.**
- **False fix.** An uncommitted md-only BUGS.md edit that moves an entry to Fixed and names a
  symbol absent from the tree yields one finding. The same edit with the symbol present yields
  none.
- **Structure.** A PLANS.md edit that duplicates `## Done` yields the structure finding.
- **Follow-up (tick-stage tests with fake pi).**
  - A finding triggers exactly one follow-up run. When that run fixes it, the change queues
    with only the "fixed" warning.
  - A finding the run leaves unfixed still queues, with the "still open" warning.
  - No findings means no follow-up run.
- **Abort.** An aborted follow-up finishes through `finishAbortedTick`, as the summary
  follow-up does.
- `npm run test` green.

### Pre-queue self-check, part 2/2: flag stale path references, nonexistent paths, and lost final newlines (planned 2026-10-06 by operator; requires part 1/2 landed)

Context: path drift is the organize loop's main rejection cause. In organize's 11 rejections from
2026-10-04 to 10-06:
- Seven left a renamed or deleted path still named in docs, comments, BUGS.md or plans/:
  40fc155e, 1ea3c96d, dd971b48, e1b4e113, 04f4be3e, 3780b9a7, 177f2481.
- One added paths that never existed: 025f5425 applied a path rewrite twice, producing
  `src/backlog/src/backlog/…`.
- One pointed at test paths that were never moved (16516b42).
- Two of the eleven also removed files' final newlines.

Each is a git-level fact the harness can compute without knowing the project's language. Today a
model reviewer finds them by grepping and rejects the refactor, which discards it even when the
reasons say the rest was verified correct.

Doc-comment debris, such as an unterminated `/**` swallowed by the next comment or an import
glued to a comment, is language-specific. It stays with the project's own lint and is out of
scope here.

**Goal.** Part 1/2's stage self-check also reports three kinds of finding. The author fixes them,
or says why not, in the follow-up turn:
- (a) every remaining reference to a path the change renamed or deleted;
- (b) repo paths named on added lines that do not exist in the resulting tree;
- (c) files whose final newline the change removed.

**Approach.** Everything goes in `src/tick/stage-check.ts`, appended to `stageCheckFindings`.
It is project-neutral and uses git only.
1. Stage with `git add -A`; commitAll restages anyway, and git state belongs to the harness.
   Read `git diff --cached -M --name-status <changeBaseRev>`.
2. **(a) Stale references.** For each `D` path and each `R` old path, run
   `git grep -n -F -I --cached -- <old path>`. Report up to 10 `file:line` hits per path in one
   finding: "<old> was renamed to <new> (or deleted) but is still named at: …".
3. **(b) Nonexistent paths.** In `git diff --cached -U0 <base>`, collect tokens on `+` lines
   shaped `<top>/<segments>.<ext>`, where `<top>` is a tracked top-level directory (from
   `git ls-files`) and the path ends in a file extension. Report those missing from the staged
   tree, except step 2's old paths, which "moved from X" prose names legitimately. Cap the
   list.
4. **(c) Final newline.** Report, in one finding, every text file in the staged diff whose new
   side ends with `\ No newline at end of file` while its base side did not. A new text file
   with no final newline counts too.
5. `buildStageFixPrompt` from part 1/2 already covers these. Each finding's text names its fix
   concretely.

**Files touched.** src/tick/stage-check.ts, test/stage-check.test.ts.

**Acceptance criteria.**
- **Stale references.** On a scratch repo, renaming `src/a.ts` to `src/x/a.ts` while README.md
  still names `src/a.ts` yields one stale-reference finding citing `README.md:<line>`.
  Updating the README clears it.
- **Nonexistent paths.** An added line naming `src/x/src/x/a.ts` yields a nonexistent-path
  finding. An added line naming the renamed-away `src/a.ts` ("moved from src/a.ts") does not.
- **Final newline.** A change that removes a file's final newline yields the newline finding.
  A file whose base already lacked one does not.
- **No noise.** Binary and untouched files produce no findings. Findings are capped, so a
  40-file rename produces a bounded finding text.
- `npm run test` green.

---

## Done

### Model failure fallback, part 2/2: show the episode on every surface (planned 2026-10-06 by plan loop; requires part 1/2 landed; done 2026-10-06 by feature)

**Goal.** An operator can see which loops are running off-model, and why, on `tumwater status`,
the TUI, and the dashboard without reading the event log.

**Approach.**
1. **`src/status/status-data.ts`** — add the active fallback (resolved pair, `since`, reason) to
   each loop row from `LoopState.modelFallback`; absent leaves the row shape byte-identical.
2. **`src/ui/status-payload.ts`, `src/ui/status-render.ts`, `src/ui/gui/gui-client-loops.ts`** — a
   `fallback` tag on the loop row (status/TUI cell and GUI row) while an episode is active.
3. **`src/roles/role-view.ts` + `src/roles/role-render.ts`** — `tumwater role <id>` names the
   effective fallback pair and "on fallback since <time> (primary failing: <reason>)".
4. **Docs** — README's Backends/Status note and docs/how-it-works.md describe the shipped
   trigger and return policy; docs/feature-model-fallback.md and
   docs/implementation-model-fallback.md are corrected to match (the probe is a real tick on the
   primary, not a separate canary request); plans/fallback-model.md's "Out of scope" line no
   longer calls failure fallback out of scope.

**Files touched.** src/status/status-data.ts, src/ui/status-payload.ts, src/ui/status-render.ts,
src/ui/gui/gui-client-loops.ts, src/roles/role-view.ts, src/roles/role-render.ts, README.md,
docs/how-it-works.md, docs/feature-model-fallback.md, docs/implementation-model-fallback.md,
plans/fallback-model.md, and their tests.

**Acceptance criteria.**
- `tumwater status --json` carries the fallback field for a role mid-episode and omits it
  otherwise; existing row snapshots are unchanged when no episode is active.
- The status/TUI loop cell and the GUI loop row show the fallback tag while active, and nothing
  otherwise.
- `tumwater role <id>` names the fallback pair and the episode's start and reason.
- The docs state the shipped trigger (3 consecutive provider-class failures), the tier-resolved
  pair, the probe tick, and the return policy; no doc still calls failure fallback out of scope.

### Model failure fallback, part 1/2: run a failing role's ticks on its tier fallback (planned 2026-10-06 by plan loop; done 2026-10-06 by feature)

Design: plans/fallback-model.md, docs/feature-model-fallback.md, docs/implementation-model-fallback.md.
The docs describe a per-role fallback on repeated backend failures; this lands the behavior
(the canary-probe wording in the docs is superseded — see part 2/2, which corrects the docs).
Part 2/2 adds the surfaces and depends on this landing.

**Goal.** When a role's primary model keeps failing with provider-class errors, keep the role's
ticks productive on its tier's resolved `fallback` pair instead of burning the error ladder
until the streak breaker pauses it, and return it to the primary once a probe succeeds.

**Approach.**
1. **`src/loop/model-fallback.ts` (new, pure).** `ModelFallbackState = { failures: number;
   since: number; probeAt: number; cooldownMs: number; reason: string }`;
   `MODEL_FALLBACK_FAILURES = 3`, `MODEL_FALLBACK_COOLDOWN_MS = 5 * 60_000`,
   `MODEL_FALLBACK_MAX_COOLDOWN_MS = 30 * 60_000`. Functions with the clock injected (no
   `Date.now()` inside): `recordModelFallback(state, { providerFailure, now, reason })` returns
   the next state — the third consecutive provider failure trips `fallback`, any other outcome
   leaves a non-tripped state and clears `failures`; `modelFallbackProbe(state, now)` is true
   only while in fallback with `probeAt` elapsed; `modelFallbackActive(state, now)` is true only
   while in fallback with `probeAt` in the future; a failed probe doubles `cooldownMs` to the cap.
2. **`src/config/config-views.ts`** — export `fallbackRoleConfig(config, role):
   ResolvedModelConfig | null`: the role's `roleSeamTier` pair from
   `resolveTierFallbacks(config, () => true)` (tier own pair, else the existing borrow order),
   shaped like `configForRole` (provider/model/thinking + the role's `minTickIntervalSeconds`).
   Null when the tier resolves to pause (no `fallback` configured), so the feature is off.
3. **`src/loop/loop-state.ts`** — `LoopState.modelFallback?: ModelFallbackState` (persisted;
   absent means primary, so existing state files read unchanged).
4. **`src/loop/loop.ts`** (`LoopRunner.tick()` and `runTick()`) — at tick start read
   `this.state.modelFallback`: with `fallbackRoleConfig` non-null and `modelFallbackActive`,
   resolve `cfg` from that fallback config, pass it as the explicit config to the authoring
   `this.pi.runRolePi(wt, prompt, name, resuming, cfg)` call, and set `tickPair` to it; with
   `modelFallbackProbe`, run the tick on the primary as the probe. At tick end, fold ONLY the
   authoring run's `PiRunResult` (`modelFallbackVerdict`, reason from `transientRateLimit` /
   `backendKind`) — not the tick's `lastRateLimit`/`lastBackendFailure` stamps, which a
   transient retry's earlier failed attempt can set without the authoring run having failed —
   call `recordModelFallback`, persist it, and emit `model_fallback_started` /
   `model_fallback_ended`. A run the harness killed (aborted, quiet-killed, timed out) is
   inconclusive, and a tick that never invoked pi leaves the episode untouched.
5. **`src/events/events.ts` + `src/events/event-format.ts`** — the two event types carry role,
   provider, model, and the tripping reason (and episode duration on end), rendered in the feed.
6. **The effective-provider wiring** (added after the 2026-10-06 review objected that a
   fallback-provider storm was never detected and a fallback tick fed the primary's breaker):
   `LoopRunner.runConfig(now)` / `runProvider(now)` resolve the pair the NEXT tick will run
   from the live config plus the episode. `src/gates/gate-polls.ts`'s `holdInputs` keys each
   role's hold observation on `runProvider(now)` instead of `configForRole`, so a storm on the
   fallback pair forms its own hold while the abandoned primary stays clear;
   `src/orchestrator/orchestrator.ts`'s `roleProviders` reads the same method; and
   `src/orchestrator/orchestrator-launch.ts` derives `ranPair` from `runConfig(now)` so a
   fallback-episode tick's outcome folds into the breaker of the pair it actually ran.

**Files touched.** src/loop/model-fallback.ts (new), src/loop/loop.ts, src/loop/loop-state.ts,
src/config/config-views.ts, src/events/events.ts, src/events/event-format.ts,
src/gates/gate-polls.ts, src/orchestrator/orchestrator.ts,
src/orchestrator/orchestrator-launch.ts, test/model-fallback.test.ts (new),
test/loop-fallback.test.ts (new), test/config-views.test.ts, test/event-format.test.ts,
test/gate-polls.test.ts, test/orchestrator-launch.test.ts.

**Acceptance criteria.**
- Two roles failing with provider-class errors on a shared fallback provider form a hold on
  that provider through `pollFleetGates`, while the abandoned primary stays clear
  (test/gate-polls.test.ts).
- State-machine unit tests: two provider failures leave the role on primary; the third trips
  fallback; a content failure (rejected/no_change/error without a provider flag) never trips and
  clears the running count; a probe is offered only after the cooldown; a successful probe clears
  the state; a failed probe doubles the cooldown to the 30-minute cap; a role whose tier resolves
  to no fallback pair never trips.
- Fake-pi integration: a role whose authoring runs fail provider-class three times runs its next
  tick with the fallback pair in the `--provider`/`--model` argv; a successful probe tick after
  the cooldown runs on the primary and emits `model_fallback_ended`; `model_fallback_started`
  precedes it in the feed.
- A role with no `fallback` configured emits no new event and its `--model` argv is unchanged.
- `npm run test` green.

### Log one `model_changed` event when a live config edit changes the fleet's model wiring (planned 2026-10-06 by director; independent of the display plan above; done 2026-10-06 by feature)

**Goal.** A live `tumwater.json` edit that changes which model a seam runs on leaves one
human-readable events.jsonl line naming the new selector, instead of only the key list the
existing `config_changed` event carries. It fires only on an actual model-wiring change — never
per tick; the per-tick `tick_start.model` field stays for the history/report trail. Budget
fallback transitions already log their model on `budget_fallback`/`budget_handback`, so this
event covers the config-edit path only.

**Approach.**
1. **`src/config/config-views.ts`** — export `fleetModelLabel(config: TumwaterConfig): string |
   null`: for each tier in `MODEL_TIERS`, format that tier's effective selector via
   `tierModel(config, tier)` and `formatModelSelector`; return null when every tier is unset
   (pi's own default), the single selector when all set tiers agree, and the
   `small=…, default=…, strong=…` list when they differ. Using all tiers makes an edit to any
   tier's entry change the label.
2. **`src/events/events.ts`** — add `"model_changed"` to the `HarnessEvent["type"]` union with
   a doc comment: "a live tumwater.json edit changed the fleet's model wiring; carries
   `from`/`to` (`fleetModelLabel` of the previous/next config) and `roles` (the per-role
   selector diffs) when a `roles.<id>` model override changed".
3. **`src/config/config-live.ts`** (`poll`, beside the existing `config_changed` block) — after
   logging `config_changed`, compute the model change: `topChanged = fleetModelLabel(prevLive)
   !== fleetModelLabel(reloaded.config)`; and from `changedKeys`' `roles.<id>` entries, keep a
   `{ role, from, to }` for each id whose `modelSelectorField(configForRole(...)).model` differs
   between `prevLive` and `reloaded.config` (imports `configForRole`, `fleetModelLabel`,
   `modelSelectorField` from config-views). When `topChanged || roleDiffs.length > 0`,
   `logEvent(root, { loop: "harness", type: "model_changed", from: fleetModelLabel(prevLive),
   to: fleetModelLabel(reloaded.config), ...(roleDiffs.length ? { roles: roleDiffs } : {}) })`.
   An edit touching no model key (e.g. `roles.<id>.instructions` or `minTickIntervalSeconds`)
   emits nothing.
4. **`src/events/event-format.ts`** — a `case "model_changed"` rendering `model changed — now
   ${e.to ?? "pi's default"}` (one feed line; the per-role diffs stay structured on the event).

**Files touched.** src/config/config-views.ts, src/config/config-live.ts, src/events/events.ts,
src/events/event-format.ts, test/config-live.test.ts, test/config-views.test.ts,
test/event-format.test.ts.

**Acceptance criteria.**
- `fleetModelLabel` returns null for an unset model, `prov-a/model-a` for the string
  `model: "prov-a/model-a"`, and a differing-tier list for `{ default: "prov-a/model-a",
  strong: "prov-s/model-s:high" }`.
- A reload whose only change is the top-level `model` logs exactly one `config_changed`
  (unchanged) followed by one `model_changed` whose `to` is the new label; an unchanged poll
  after it logs nothing more (edge-triggered like `config_changed`).
- A `roles.qa.model` edit logs a `model_changed` whose `roles` holds `{ role: "qa", from, to }`;
  a `roles.qa.instructions` edit logs `config_changed` and no `model_changed`; a
  `minTickIntervalSeconds`-only edit logs no model event.
- `event-format` renders `model changed — now prov-a/model-a`.
- `npm run test` green.

### Show each loop's active model on `tumwater status`, the TUI, and the GUI (planned 2026-10-06 by director; done 2026-10-06 by feature)

**Goal.** An operator can see, on both observer surfaces, which model every loop runs on — not
only when a tier map is declared. The per-row model selector was attached only when the
top-level `model` is a tier-map object (`src/status/status-data.ts`'s `snapshot`, the
`isJsonObject(cfg.model)` gate), so the common single-string model (`model: "provider/id"`)
was invisible: the GUI sub line and the TUI name suffix stayed bare. (`src/ui/gui/gui-client-loops.ts`'s
`loopCells` already renders `l.model` when present, and `src/ui/status-payload.ts` already
forwards `s.model`; its stale comment was corrected to match.)

**Approach.**
1. **`src/status/status-data.ts`** (`snapshot`, the `loops` map): always compute
   `configForRole(cfg, r)` and spread `...modelSelectorField(eff)` into every row. Keep
   `modelTier: roleSeamTier(cfg, r)` gated on `isJsonObject(cfg.model)` exactly as today (the
   tier tag stays a tier-map-only affordance). Updated the `StatusSnapshot.loops` field comment:
   `model` is now present whenever a model resolves, `modelTier` only under a tier map.
2. **`src/ui/status-render.ts`** (the row's `name` cell): replaced the
   `s.modelTier ? \` (${s.modelTier}${s.model ? ` · ${s.model}` : ""})\` : ""` suffix with one
   that also renders a lone model: with `s.modelTier` it keeps today's ` (tier · selector)` text
   byte-for-byte; otherwise with `s.model` it appends ` (${s.model})`; with neither it appends
   nothing.
3. **`src/ui/gui/gui-client-loops.ts` needed no change** — verified it already renders `l.model`.
   **`src/ui/status-payload.ts`** already forwarded `s.model`; only its comment was corrected.

**Files touched.** src/status/status-data.ts, src/ui/status-render.ts, src/ui/status-payload.ts,
test/status-data.test.ts, test/status-render.test.ts.

**Acceptance criteria.**
- With `model: "prov-a/model-a"` and no map, every `snapshot(repo).loops` row carries
  `model: "prov-a/model-a"` and no `modelTier`; `statusPayload(repo).loops` forwards the same
  `model`; `renderStatus` shows an isolated row supplied `{ role: "clean", model:
  "prov-a/model-a" }` as `clean (prov-a/model-a)`.
- With the tier map `{ default: "prov-a/model-a", strong: "prov-s/model-s:high" }`, every row
  carries `modelTier` and `model` exactly as today and `renderStatus` keeps the byte-identical
  ` (strong · prov-s/model-s:high)` suffix (the existing status-render tier test stays green).
- The old test "snapshot loop rows carry their seam tier and selector only when a tier map is
  declared" was renamed to "snapshot loop rows carry the resolved selector always and the seam
  tier only under a tier map": the no-map branch asserts `model` is present and `modelTier`
  stays undefined; a new status-render case pins the lone-model suffix.
- `npm run test` green.

### Per-tick prompt-token telemetry: record prompt, cache-read, and pre-first-edit tokens on tick_end (planned 2026-10-06 by operator; done 2026-10-06 by feature)

Context: a 2026-10-06 analysis of 684 ticks (Oct 2–6) had to rebuild these numbers from pi
session files, because tick_end carries only output tokens (`tokens`) and `costUsd`.
- 92% of prompt tokens are cache re-sends.
- About half of all prompt tokens are spent before a tick's first edit. Ticks that never edit
  account for 18%, and ticks that do edit spend 42% of theirs before the first edit.

Without these numbers on the event feed, nobody can tell whether a prompt or context change
made ticks leaner. That includes the BUGS.md backlog-index fix filed the same day and the role
notebook planned below.

**Goal.** Every tick_end reports three numbers: the prompt tokens the tick sent, how many of
them were cache reads, and how many were sent before the tick's first edit. A prompt or
context change can then be measured from events.jsonl alone.

**Approach.**
1. **`src/pi/pi-stream.ts`** — in the `message_end` assistant branch, accumulate
   `promptTokens += input + cacheRead + cacheWrite` (via `usageNumber`) and
   `cacheReadTokens += cacheRead`. Until the first assistant message whose content holds a
   `toolCall` named `edit` or `write`, also accumulate `preEditPromptTokens`, including that
   message's own prompt. Record `firstEditTurn` (1-based; undefined when the run never edits).
2. **`src/pi/pi-run-result.ts`** — carry the four fields on `PiRunResult` (built in
   `src/pi/pi.ts`).
3. **`src/tick/tick-usage.ts`**
   - `TickUsage` gains per-tick `promptTokens`, `cacheReadTokens`, `preEditPromptTokens` and
     an `editSeen` flag, all cleared in `reset()`.
   - `fold()` adds `promptTokens` and `cacheReadTokens` for every run, like `costUsd`.
   - `fold()` adds a run's `preEditPromptTokens` only for authoring runs and only while
     `editSeen` is false, then sets `editSeen` once a run reports `firstEditTurn`. Landing,
     review and conflict-resolution runs fold with `authoring=false`: `src/loop/loop.ts`'s
     `foldLandingUsage` and the `LoopPi` host's `foldLandingUsage` face (src/loop/loop-pi.ts)
     route every landing/review/conflict run there — including a retried gate attempt and the
     conflict resolver — so none of them touch the pre-edit counter.
4. **`src/tick/tick-finalize.ts`** — tick_end carries `promptTokens`, `cacheReadTokens` and
   `preEditPromptTokens`, omitted when zero, the same way `usageFragment` treats its fields.
5. **Telemetry digest** (`src/failure/failure-data.ts` / `src/failure/failure-render.ts`) —
   the collector folds each tick_end's `promptTokens`/`preEditPromptTokens` into a per-role
   `promptStats` row (median `promptTokens` per tick, and the pre-edit share: sum of
   `preEditPromptTokens` over sum of `promptTokens`), and the render adds a
   `## Prompt tokens by role` section. A log whose tick_ends predate the fields yields no rows,
   so old digests render byte-identically. `src/tick/telemetry-digest.ts` needed no change: it
   is a thin wrapper over `renderFailureMarkdown`, so the section flows through it automatically.

**Files touched.** src/pi/pi-stream.ts, src/pi/pi-run-result.ts, src/pi/pi.ts,
src/tick/tick-usage.ts, src/tick/tick-finalize.ts, src/loop/loop.ts, src/loop/loop-pi.ts,
src/failure/failure-data.ts, src/failure/failure-render.ts, test/pi-parser.test.ts,
test/tick-usage.test.ts, test/tick-finalize.test.ts, test/failure-render.test.ts,
test/loop-pi.test.ts, test/fake-pi.ts. (The plan named `test/pi-stream.test.ts`; the parser's
single unit-test home is test/pi-parser.test.ts, where its existing usage tests live.)

**Acceptance criteria.**
- A stream of three assistant messages with set `usage.input`/`usage.cacheRead`, where the
  second holds an `edit` toolCall, yields `promptTokens` and `cacheReadTokens` equal to the
  sums, `preEditPromptTokens` equal to the first two messages' prompts, and `firstEditTurn` 2.
- A run with no edit or write has `preEditPromptTokens == promptTokens`.
- A tick whose resumed second run follows an edit in its first run adds nothing to the
  pre-edit counter. A landing run's usage reaches `promptTokens` but not
  `preEditPromptTokens` — `runLandingPi` and `runGatePi` fold through `foldLandingUsage`
  (pinned in test/loop-pi.test.ts), and `TickUsage.fold(..., false)` never advances the prefix
  (test/tick-usage.test.ts).
- tick_end lines in events.jsonl carry the three fields, and a tick with no usage omits them.
  Existing report and digest output is unchanged apart from the new digest line.
- `npm run test` green.

### GUI Pending view: show each loop's unlanded change in the dashboard (planned 2026-10-06 by plan loop; done 2026-10-06 by feature)

The CLI answers "what is each loop about to land" with `tumwater diff` (`--json`, `--role <id>`), but the browser dashboard — the operator's primary observer surface — has no way to see a loop's pending unlanded work: Fleet/History/Usage/Failures/Settings all render state and history, and the loop drawer shows status and transcript only. The data already exists and is shared: `collectFleetChanges` / `collectRoleChange` (src/change/change-data.ts) produce the exact `FleetChangeView` / `RoleChangeView` documents `tumwater diff --json` prints, so the GUI reuses them unchanged.

**Goal.** Add a Pending view to the dashboard that lists each role's unlanded work (branch, state, ahead count with commit subjects, dirty-file count) and opens a role's full diff, powered by the existing change collectors.

**Approach.** The landed change follows the plan; where the anchors named the wrong module it was corrected in place rather than refused.
1. **`src/gui/gui-endpoints.ts`** — the `async handleDiff(q, res, root)` handler: no `role` param → `sendJson(res, 200, await collectFleetChanges(root))` (the same payload `tumwater diff --json` prints); `?role=<id>` → `rejectBadRole` first (the same target validation and 400 wording as `/api/transcript` and `/api/tick`, so a traversal-shaped id never reaches the collector) and then `collectRoleChange(root, <id>)` (the full patch view, as `tumwater diff --role <id> --json` prints). Every /api handler lives in this module by its own contract, so the plan's `gui-server.ts` handler note was corrected; **`src/gui/gui-server.ts`** routes `GET /api/diff` to it.
2. **`src/ui/gui/gui-page.ts`** — a `Pending` tab in `viewnav` (after Failures) and a `<section id="pending" class="view" aria-label="Pending" hidden>` container, mirroring the Failures section.
3. **`src/ui/gui/gui-client-boot.ts`** — `pending` registered in `VIEWS` and `fetchPending()` called from `switchView`, alongside `fetchHistory`/`fetchReport`/`fetchFailures`.
4. **`src/ui/gui/gui-client-pending.ts`** (new section, spliced into gui-client.ts like its siblings) — `fetchPending` loads `/api/diff`; `renderPending` paints a pure roster (loop, branch, state, ahead count with commit subjects, dirty-file count; `ready` with no work shows idle; `absent`/`no-base` show their degraded line), and each row opens the loop drawer. **`src/ui/gui/gui-client-drawer.ts`** adds the drawer's "Pending change" section — it fetches `/api/diff?role=<id>` once on open and renders the full patch (commits, ahead-of-main diff, uncommitted files and diff), and it renders even for a role absent from `statusPayload.loops` (a disabled loop), so those roster rows can show their patch too. **`src/ui/gui/gui-styles.ts`** styles the scrollable diff. The roster renderer stays pure so it is unit-testable without a server.

**Files touched.** src/gui/gui-endpoints.ts, src/gui/gui-server.ts, src/ui/gui/gui-page.ts, src/ui/gui/gui-client.ts, src/ui/gui/gui-client-boot.ts, src/ui/gui/gui-client-pending.ts (new), src/ui/gui/gui-client-drawer.ts, src/ui/gui/gui-styles.ts, test/gui-endpoints.test.ts, test/gui-client-pending.test.ts (new), test/gui-client-boot.test.ts, test/gui-client-drawer.test.ts, docs/how-it-works.md.

**Acceptance criteria.**
- `GET /api/diff` returns a document matching `tumwater diff --json` for the same tree (same `mainBranch` and `roles` arrays, no per-role patch fields); `GET /api/diff?role=<id>` matches `tumwater diff --role <id> --json` for a role holding work and for an absent/no-base role.
- The viewnav shows Pending; the Pending view lists every role's branch, state, ahead count with commit subjects, and dirty-file count; a role holding no unlanded work renders its idle state; opening a role row shows its full diff in the drawer.
- The existing five views render unchanged; the new endpoint degrades on a fresh or incomplete repo the way the change collectors do, without throwing.

### Model tiers, part 8/8: writers emit the new form, and the docs describe tiers (planned 2026-10-05 by operator; requires parts 1/8–7/8 landed; done 2026-10-06 by feature)

Design: plans/model-tiers.md ("Backward compatibility", "Notes for local fallbacks").

**Goal.** Everything tumwater writes uses the new keys, and the docs teach the one-line
single-model form first, then tiers.

**Approach.**
1. **`setConfigKey` / `parseConfigKey`** (src/config/config-write.ts) — the one writer behind both
   `tumwater config set` (src/cli/config-commands.ts) and the GUI's config edits
   (src/gui/gui-endpoint-commands.ts) — and `EDITABLE_CONFIG_KEYS` (src/config/config-editable-keys.ts):
   `model` takes a selector, a dotted `model.strong` merges one map entry (the way
   `roles.qa.model` already merges a role entry), and `fallback` is editable. `provider` stays
   accepted for legacy configs and is never written into a config that lacks it.
2. **Docs:** README.md (the "Backends" line), docs/backends.md (config examples, the
   local-fallback memory and `compat.thinkingTokenBudgetField` notes), docs/how-it-works.md
   (seams and tiers), docs/feature-model-fallback.md and docs/implementation-model-fallback.md
   (per-tier fallback and the borrow order).

**Files touched.** src/config/config-write.ts, src/config/config-editable-keys.ts, README.md, the four docs/
files above, and the config-write tests.

**Acceptance criteria.**
- `tumwater config set model huggingface/zai-org/GLM-5.3-Flash:together:low` writes one key;
  `tumwater config set model.strong <selector>` turns a string `model` into
  `{ default: <old>, strong: <selector> }`.
- No writer adds `provider` or `fallbackModel` to a config that does not already have them.
- The docs show the single-model form before any tier example.

**Landed 2026-10-06.** `model.<tier>` merges one map entry, promoting a string `model` to
`{ default: <old>, <tier>: <selector> }` while keeping the other tiers; `config set` refuses to
add legacy `provider`/`fallbackModel` to a config that lacks them but still updates one that has
them; `fallback` joins the GUI's `EDITABLE_CONFIG_KEYS`; the docs lead with the single-selector
form. The two failure-fallback plan docs (feature-/implementation-model-fallback.md) name the
current `fallback` key (legacy alias noted); their failure-triggered state machine remains a
separate, unlanded plan.

### Model tiers, part 7c/8: the doctor checks every declared tier model (planned 2026-10-05 by operator; split 2026-10-06 by feature from part 7/8 — too large for one run; requires parts 3/8 and 5/8 landed, 7a done; done 2026-10-06 by feature)

Design: plans/model-tiers.md ("Doctor"). Split from part 7/8; sibling 7a landed the role rows.

**Goal.** `tumwater doctor` catches a tier model pi cannot resolve, or a provider without
credentials, before the fleet finds out the hard way mid-review.

**Approach.** src/doctor/doctor-checks.ts: a new `checkTierModels` verifies that every declared
tier model resolves in pi's catalog and that its provider reports `ready` from
`pi auth check --provider <p> --json` (probe verdict ready/not-ready/unknown; injectable so
tests never spawn pi). When `PI_SMOL_MODEL`, `PI_SLOW_MODEL`, or `PI_PLAN_MODEL` is set, it
notes that tumwater does not read them — they are oh-my-pi's, pi ignores them, and with omp as
`agentBin` they reach omp through the inherited environment — and points at `model.small` /
`model.strong`. Scope note: per-tier fallback pricing stays on `checkFallbackModel`'s existing
default-pair report rather than extending it to each tier's fallback — the gate already prices
every tier's resolved pair at resolution time (part 5a/8), so a doctor re-derivation would only
restate it.

**Files touched.** src/doctor/doctor-checks.ts (checkTierModels, piProviderAuth),
src/doctor/doctor.ts (wiring, new "tier models" row), test/doctor-checks.test.ts,
test/doctor.test.ts (the pinned check-name list).

**Acceptance criteria.**
- `tumwater doctor` fails a tier model pi cannot resolve, warns on a provider that is not
  `ready`, and prints the `PI_*_MODEL` note only when one is set.

### Model tiers, part 7b/8: the `budget_fallback` badge lists the tiers (planned 2026-10-05 by operator; split 2026-10-06 by feature from part 7/8 — too large for one run — into role rows (7a), this badge, and the doctor checks (7c); requires parts 3/8 and 5/8 landed, 7a done; done 2026-10-06 by feature)

Design: plans/model-tiers.md ("Observability"). Split from part 7/8; sibling 7a landed the role
rows.

**Goal.** A `budget_fallback` engaged on a tiered fallback shows which pair each tier resolved
to, so an operator can see a strong-tier borrow at a glance.

**Approach.** `budget_fallback` (src/gates/budget-gates.ts emitting, src/events/event-format.ts
formatting) gains `tiers: { <tier>: "<selector>[ (from <tier>)]" }` beside its existing
`provider` / `model` (the default tier's), so current readers keep working. The header badge
(src/ui/badges.ts and the GUI twin) keeps today's single-name text when every tier shares one
pair, and lists the tiers otherwise.

**Files touched.** src/gates/budget-gates.ts, src/events/event-format.ts, src/ui/badges.ts, the
GUI badge, and their tests.

**Acceptance criteria.**
- A `budget_fallback` with two distinct tier pairs lists both, with `(from default)` on a
  borrowed one.
- With a single fallback the badge text is byte-identical to today's.

### Model tiers, part 7a/8: role rows show each loop's seam tier and resolved selector (planned 2026-10-05 by operator; split 2026-10-06 by feature from part 7/8 — too large for one run — into role rows, the tiers badge (7b), and the doctor checks (7c); requires parts 3/8 and 5/8 landed, done 2026-10-06 by feature)

Design: plans/model-tiers.md ("Observability"). Split from part 7/8; siblings 7b (the
`budget_fallback` tiers badge) and 7c (the doctor checks) remain planned.

**Goal.** An operator can see, on every dashboard row, which model tier a loop's pi runs resolve
at and what that tier resolves to — without reading tumwater.json.

**Approach.** `rolePayload` (src/roles/role-view.ts) gained `modelTier: ModelTier` (always —
`roleSeamTier`), and its Markdown renderer names the tier on the Model line. The status snapshot
(src/status/status-data.ts) adds `modelTier` and `model` (`provider/id[:thinking]`, the
`configForRole` view) to each loop row — present only when the top-level `model` is a tier map,
so single-model configs keep today's row shape byte-for-byte. Both dashboards render it: the
TUI/status table appends ` (tier · selector)` to the loop name cell (src/ui/status-render.ts),
the GUI's loop row carries a tier tag beside the name and the selector in the sub line
(src/ui/status-payload.ts, src/ui/gui/gui-client-loops.ts).

**Files touched.** src/roles/role-view.ts, src/roles/role-render.ts, src/status/status-data.ts,
src/ui/status-payload.ts, src/ui/status-render.ts, src/ui/gui/gui-client-loops.ts, and tests
(test/role-view.test.ts, test/status-data.test.ts, test/status-render.test.ts,
test/gui-client-loops.test.ts).

**Acceptance criteria met.**
- Role rows show `strong` and its model for plan with a strong tier declared (catalog
  assignment; a tier-name `roles.<id>.model` override and an undeclared tier inheriting
  `default` both covered in the role-view and status-data tests).
- With no tier map the rows keep today's shape — the fixture tests pin the absent fields and
  the unchanged name cell.
### Model tiers, part 5c/8: budgetGate semantics, the per-role pause set, and handback by resolved pair (planned 2026-10-06 by feature, split from part 5/8; requires parts 5a/8 and 5b/8 landed, done 2026-10-06 by feature; an earlier draft was rejected in review — pair-blind probe piercing, a probe that deadlocked the launch pass, and an observer pause set fed by one pair's breaker only — all three reworked in this landing)

**Approach.**
1. **src/budget/budget.ts `budgetGate`:** `paused` when `default` resolves to pause, or when review is
   on and `strong` does (nothing could land); `fallback` otherwise. A role whose own tier
   resolved to pause (strong-tier roles with review off) is blocked beside the poll's
   per-role `capPaused` set (src/gates/gate-polls.ts, filled by src/gates/role-cap-gates.ts), and its row
   reads `budget paused`.
2. **Budget handback** (src/gates/gate-polls.ts): the running tick's `tickPair` (src/loop/loop.ts) is
   matched against every resolved fallback pair, not only one.

**What changed.** `budgetGate` (budget.ts) now takes the tiers' resolutions and the review flag; a new
`modelPairName` helper single-homes the pair-name keying. `pollBudgetGate` (budget-gates.ts) resolves
twice: price-based (`priceResolved` — the breaker map's keys, the per-tier fallback view via
`applyFallbackModel(liveConfig, priceResolved)`, the handback pair list) and demotion-aware
(`servingResolved` — the gate's value and the per-role pause set), so a demoted pair re-resolves only
the tiers using it. `gate-polls.ts` computes `budgetPausedRoles` (roles whose `roleSeamTier` tier
resolved to pause while the cap is reached), publishes every pair's demotion
(`info.fallbackDemotions`, with the engaged pair's entry also in the legacy `fallbackDemoted` field),
and runs the handback over every resolved pair. The orchestrator computes `probeRoles` from the
PRICE-based resolution (the probed pair is by definition absent from the serving one) and passes the
per-tier pause set, the probe roles, and the review-on strong pause to `pollRunnerReasons`
(orchestrator-scheduling.ts), which pierces the budget hold only for the probed pair's own tier;
`launchDueTicks` (orchestrator-launch.ts) admits the probe only among `probeRoles`, one per poll, and
continues only further eligible runners — never the rest of the fleet — while tick evidence folds
into the breaker of the pair the runner's own config view names. Observers: status-data.ts computes
`budgetPausedRoles` from the same resolution over the published demotions, status-model.ts reads the
per-role set for the `budget paused` cell, and badges.ts's header badge keeps the default-tier story.
`roleSeamTier` is exported from config-views.ts for both readers. Files touched beyond the entry's
original list, which its anchors no longer named: src/gates/budget-gates.ts, src/config/config-views.ts,
src/orchestrator/orchestrator.ts, src/orchestrator/orchestrator-scheduling.ts,
src/orchestrator/orchestrator-launch.ts, src/status/status-data.ts, src/ui/status-model.ts,
src/ui/badges.ts, src/fleet/fleet-state.ts.

**Files touched.** src/budget/budget.ts, src/gates/gate-polls.ts, src/gates/role-cap-gates.ts, src/loop/loop.ts,
and their tests.

**Acceptance criteria.**
- With review on and strong unresolvable, the gate is `budget_paused`; with review off, only
  the plan role is held.
- A breaker-demoted pair re-resolves only the tiers using it.
- The director still keeps its paid model.

### Model tiers, part 5b/8: the fallback breaker becomes a map keyed by pair (planned 2026-10-06 by feature, split from part 5/8; requires part 5a/8 landed, done 2026-10-06 by feature)

**Approach.** **src/budget/fallback-breaker.ts / src/gates/budget-gates.ts:** `BudgetGateState.breaker`
becomes a map keyed by pair name, `rekeyFallbackBreaker` runs per pair, and `usable(pair)` =
`pairFree(...)` and `fallbackServing(...)`. Tiers sharing a fallback pair share a breaker, and a
demoted pair re-resolves only the tiers that use it.

**What changed.** The map landed as `BudgetGateState.breakers` plus a new `engaged` pair name (fallback-breaker.ts's `FallbackBreakerMap` and per-pair helpers; orchestrator.ts, orchestrator-launch.ts, and gate-polls.ts index by pair). The poll re-keys the map per pair over the pairs the tiers resolve to absent a demotion; the `usable` predicate is the price check composed with `fallbackServingPair` for the engaged pair, and feeding the full predicate into `resolveTierFallbacks` (so a demoted pair re-resolves only the tiers using it) lands with the gate wiring in part 5c/8.
### Model tiers, part 5a/8: the per-tier budget-fallback resolution engine (planned 2026-10-05 by operator; split 2026-10-06 by feature from the original part 5/8 — too large for one run — into the resolution engine, the breaker map, and the gate wiring, done 2026-10-06 by feature)

Design: plans/model-tiers.md ("Budget fallback by tier").

**Goal.** The pure resolution layer for per-tier fallbacks: given a config and a
`usable(pair)` predicate, say which free pair each tier runs on at the cap and which tier
it was borrowed from, and rewrite a config's model map to those pairs. A single `fallback`
(or legacy `fallbackModel`) behaves exactly as today.

**Approach.**
1. **src/config/config-views.ts:** `resolveTierFallbacks(config, usable)` returns, per tier, the pair
   it runs on plus the tier it was borrowed `from`, or `"pause"`. A tier uses its own fallback
   when `usable(pair)`; otherwise it borrows another tier's own fallback (never a borrowed one)
   in the order small → default → strong, default → strong → small, and
   strong → default → pause, never small. An explicit `"pause"` value opts a tier out.
   `applyFallbackModel(config, resolved)` rewrites the `model` map to those pairs, so each seam
   keeps its tier; drops raw per-seam selector overrides while keeping tier-name ones; and keeps
   the `FALLBACK_REVIEW_TIMEOUT_S` floor.
2. **src/budget/fallback-breaker.ts / src/gates/budget-gates.ts (part 5b/8), src/budget/budget.ts,
   src/gates/gate-polls.ts, src/loop/loop.ts (part 5c/8):** later ticks wire the engine into the
   gates.

**Files touched.** src/config/config-views.ts and its tests.

**Acceptance criteria.**
- `{ "fallback": F }` resolves every tier to F, default own and the others borrowed from
  default, when `usable(F)`.
- With `fallback: { default: D, strong: S }` and both usable, default and strong run their own
  pairs and small borrows D; without `S`, strong borrows D; without `D` but with `small: M`,
  small runs M, default borrows M, and strong pauses (never borrows small).
- An explicit `"pause"` on a tier opts it out, and other tiers do not borrow it.
- `applyFallbackModel(config, resolved)` writes the per-tier selector map, drops raw per-role
  selector overrides, keeps tier-name ones, and raises the reviewer's timeout floor.
- Calling `applyFallbackModel(config)` with no `resolved` keeps today's single-fallback
  behavior byte for byte.

### Model tiers, part 6/8: the fleet-wide backend hold keys storms by provider (planned 2026-10-05 by operator; requires part 3/8 landed, done 2026-10-06 by feature)

Design: plans/model-tiers.md ("Fleet hold per provider").

**Goal.** `fleetHold` (src/fleet/fleet-hold.ts) trips one fleet-wide hold when `HOLD_STORM_ROLES`
roles fail the same way within `HOLD_STORM_WINDOW_MS`; it assumes a single backend. Once seams
run on different providers, a 429 storm at the reviewer's provider would stop authors on a
healthy one. Hold only what the failing provider serves.

**Approach.**
1. `HoldObservation` gains `provider` (from the run's resolved config — gate-polls builds each
   runner's HoldInputs provider via `configForRole`; undefined when pi's default is in charge);
   observations count toward one storm only when both provider and kind match.
2. `FleetHold` holds per provider: `FleetHold` itself gained the `provider` it is about, and
   `pollFleetHold` (src/fleet/fleet-polls.ts) keeps one hold PER PROVIDER in `states.fleetHold` (a
   `Map<string | undefined, FleetHold>`, src/gates/gate-polls.ts). A provider whose hold re-opened
   STAYS keyed in the map — its kind, provider, relapse count, and re-open time are the
   relapse memory — so "held" is read only through fleet/fleet-hold.ts's new `heldProviders()`
   (until non-null), never bare key presence: a lifted hold never keeps blocking. The
   scheduling pass (src/orchestrator/orchestrator-scheduling.ts) blocks a role when its tick model's
   provider (a per-poll `roleProviders` map) is held, or when `reviewHeld` stands; the
   orchestrator (src/orchestrator/orchestrator.ts — also touched, beyond the original list, because the
   permit-time closures read the holds there) computes both from the latest poll's map, and
   its landing-drain gate blocks only on `reviewHeld`. A hold on the reviewer's provider while
   review is on blocks every role, because nothing could land.
3. The `rate_limit_hold` / `rate_limit_resumed` events carry the provider when one is
   configured (omitted for pi's default, so an unconfigured fleet's events render exactly as
   before); event-format names the provider and scopes "role loops on that provider / every
   provider".

**Files touched.** src/fleet/fleet-hold.ts, src/fleet/fleet-polls.ts, src/gates/gate-polls.ts,
src/orchestrator/orchestrator-scheduling.ts, src/orchestrator/orchestrator.ts, src/events/events.ts, src/events/event-format.ts,
test/fleet-polls.test.ts, test/orchestrator-seams.test.ts, test/event-format-fleet.test.ts,
and the new test/orchestrator-scheduling.test.ts.

**Acceptance criteria.**
- Two roles failing with 429 on provider P within the window hold roles on P only; roles on Q
  keep ticking (pinned in test/fleet-polls.test.ts and, through the scheduling pass,
  test/orchestrator-scheduling.test.ts — including the storm → lift → subsequent-poll arc the
  2026-10-06 review called untested: the lift clears `heldProviders()`, the entry stays keyed
  with its relapse memory, and the next poll re-admits the previously held roles).
- With every seam on one provider, behavior is identical to today (existing fleet-hold tests
  pass unchanged; undefined providers group as one key).
- A storm on the reviewer's provider with review on holds the fleet (pinned through
  scheduling in test/orchestrator-scheduling.test.ts).

### Model tiers, part 4/8: the conflict resolver runs on the strong tier (planned 2026-10-05 by operator; requires part 3/8 landed and running, done 2026-10-06 by feature)

Design: plans/model-tiers.md ("Which tier each seam uses"). It changes how landings behave, so it
is its own sub-plan and lands only once part 3/8 is the running build.

**Goal.** `resolveConflict` (src/landing/landing-merge.ts) runs pi through the authoring loop's
own config, so a conflict is resolved by whichever model wrote the change. Run it on the strong
tier instead: resolution is rare, tolerant of latency, and edits code inside landing (BUGS.md,
"A conflict resolution that changes the approved change's scope lands unreviewed").

**Approach.**
1. **src/config/config-views.ts:** `resolverConfig(config)` installs `tierModel(config, "strong")` over
   `config`. Because it reads whatever config the landing is handed, it follows the budget
   fallback's config once part 5/8 lands.
2. **`RunsPi.runPi`** (src/loop/loop-pi.ts) takes an optional fourth `config` argument. The loop's
   wiring (src/loop/loop.ts, `runPi: (w, prompt, sessionName) => this.pi.runRolePi(...)`) passes it
   to `LoopPi.runRolePi`, where it replaces `configForRole(...)` in `loopPiOpts` for that run.
   `resolveConflict` passes `resolverConfig(...)`; the session dir, raw log, transient retry,
   and usage folding (charged to the authoring role) are unchanged.

**Files touched.** src/config/config-views.ts, src/loop/loop-pi.ts, src/loop/loop.ts,
src/landing/landing-merge.ts, and the landing-merge and loop-pi tests.

**Landed 2026-10-06 by feature.** As planned: `resolverConfig(config)` = `withModelOverrides(config, "strong", {})`
in src/config/config-views.ts (one definition over the tier map, so it follows the budget
fallback's config once part 5/8 lands); `RunsPi.runPi` gained the optional fourth `config`
argument, forwarded by loop.ts's wiring to `LoopPi.runRolePi` and replacing `configForRole(...)`
in `loopPiOpts` for that run; `resolveConflict` passes `resolverConfig(ctx.config)`. Session
dir, raw log, transient retry, and the authoring-role usage fold are unchanged. Tests: the
loop-pi suite pins the authoring run's argv to default's and the resolver run's to the strong
model's (and argv-identical with only `default` declared); the landing-merge suite pins the
config the resolver run is handed. Same run also pinned test/gate-polls.test.ts's
roleQuietHeld test to a fixed local mid-day clock: a real 23:59:xx run fell outside the
`00:00-23:59` window (the end minute is exclusive) and flaked the suite.

**Acceptance criteria.**
- With `strong` declared, a conflict-resolution run carries the strong model's argv while the
  authoring run carries `default`'s.
- With only `default` declared, the resolver's argv is unchanged from today.
- The resolver's spend still folds into the authoring role's usage.

- Model tiers, part 3/8: `small` / `default` / `strong` tier maps and the built-in tier of each role and the reviewer (planned 2026-10-05, done 2026-10-05; commit 7d2a9496)
- Model tiers, part 2/8: record the model each pi run used on `tick_start` and `review_start` (planned 2026-10-05, done 2026-10-05; commit 0b11f812)
- Model tiers, part 1/8: `provider/id[:thinking]` selector strings for `model`, and `fallback` as the new name of `fallbackModel` (planned 2026-10-05, done 2026-10-05; commit 3766e7f7)
- `tumwater prompt --attach <path>` — attach an image to a queued prompt from the CLI (planned 2026-10-04, done 2026-10-04; commit 9271b75d)
- `tumwater prompt --edit <n> <text...>` — correct a queued steering prompt in place, keeping its position and deferral (planned 2026-10-04, done 2026-10-04; commit e8720e45)
- `tumwater retire --role <id>` — remove a disabled loop's worktree and branch (planned 2026-10-04, done 2026-10-04; commit 5f007251)
- A shared test-fake catalog — the infrastructure that retires the recurring `no-fake` validation gap (planned 2026-10-04, done 2026-10-04; commit 8bce70cb)
- `tumwater bug "<symptom>"` and `tumwater plan "<title>" [body...]` — operator-authored backlog entries from the CLI (planned 2026-10-04, done 2026-10-04; commit fb5d9542)
- `tumwater tick <role> --last` — the newest tick's trail without knowing its number (planned 2026-10-04, done 2026-10-04; commit cce9ecf1)
- `tumwater run --for <duration>` — a bounded fleet run that drains and exits at the deadline (planned 2026-10-04, done 2026-10-04; commit 427c7d9c)
- Dotted per-role config keys: `config get/set maxDailyCostUsdPerRole.<role>` and `roles.<id>.<field>` (planned 2026-10-04, done 2026-10-04; commit 6e11f35c)
- `tumwater wake --in <duration>` — schedule a wake that arrives later, the scheduled sibling of `pause --for` (planned 2026-10-04, done 2026-10-04; commit ba0782cc)
- Per-role quiet hours: `quietHoursPerRole`, the scheduled sibling of `maxDailyCostUsdPerRole` (planned 2026-10-04, done 2026-10-04; commit 862b8145)

- `tumwater prompt --at <duration>` — queue a steering prompt that stays hidden until its time arrives (planned 2026-10-04, done 2026-10-04; commit 654f15b3)
- `tumwater questions` — read and answer the open-question outbox from the CLI (planned 2026-10-04, done 2026-10-04; commit 7cf0c37a)
- `tumwater init --template` — seeded project templates so a fresh fleet starts with signal (planned 2026-10-04, done 2026-10-04; commit a412d97d)
- The TUI's Ctrl+D quits like shell EOF and Ctrl+C interrupts the director's in-flight tick (planned 2026-10-04, done 2026-10-04; commit 4da5e4df)
- `tumwater prompt --file <path>` — queue a steering prompt from a file or stdin (planned 2026-10-03, done 2026-10-03; commit e6b8850d)
- The dashboard's Settings view: view and edit the curated top-level config keys live (planned 2026-10-02, done 2026-10-02; commit b03d653b)
- The TUI moves to ink, part 3/3: retire the hand-rolled renderer remnants and correct the docs (planned 2026-10-01, done 2026-10-02; commit 75c42c9a)
- The TUI moves to ink, part 2b/3: key handling moves to ink's `useInput` (planned 2026-10-01, done 2026-10-02; commit 4576a0c3)
- The TUI moves to ink, part 2a/3: extract the key handler from `runTui` into a framework-free module (planned 2026-10-01, done 2026-10-02; commit 5511dafd)
