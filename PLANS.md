# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

### Adversarial review gate before merge (planned 2026-08-24, refined 2026-08-25)

Full plan: [plans/review-gate.md](plans/review-gate.md). No code diff reaches main unreviewed: a
fresh-session pi run (no author context; own model override via a `review` pseudo-role) reviews
the full ahead-of-main diff against PRINCIPLES.md and replies `VERDICT: approve|reject` with
reasons. Rejects reset the branch, record reasons, and inject them into the author's next tick —
the only cross-tick memory, since sessions are fresh per tick; md-only diffs are exempt so notes
stay cheap. The invariant is structural — a failed or verdict-less review fails closed (commit
stays on the branch for re-review next tick, 3-strike discard cap), and both `recoverLeftover`'s
salvage and resumed ticks' leftover commits route through the same gate so no crash path can land
unreviewed work. The report's highest-leverage item — we have merged broken work twice for lack of
it.

### The right to refuse, and friction as a signal (planned 2026-08-24, refined 2026-08-25)

Full plan: [plans/refusal-and-thrash.md](plans/refusal-and-thrash.md). A new
`TUMWATER_REFUSED: <reason>` sentinel and `refused` tick outcome let a loop decline work that
would harm the architecture, recording the objection in PLANS.md/BUGS.md. Discard semantics are
decided: the markdown note always commits and merges (the durable record); any non-markdown
half-work is discarded — tracked edits via reset, untracked files via clean; a no-note refusal
resets cleanly with the reason kept in event + lastSummary. High-friction ticks (turn/time
thresholds from `PiRunResult.turns` + wall-clock) are flagged by warning event and, once
commit-bodies lands, its reserved trailer line — matsemann's "difficulty is a signal" restored as
data.

### Self-explaining commit bodies (planned 2026-08-24, refined 2026-08-25)

Full plan: [plans/commit-bodies.md](plans/commit-bodies.md). Reply contract grows WHY/RISK/
VERIFIED lines after SUMMARY; commits get that body plus a harness-stamped trailer (tick, turns,
peak ctx). Gives the reviewer, steward, and human a paper trail of claimed understanding
(TonyAlicea10's do-i-understand, inverted for agents). The trailer's turn count is the same
`PiRunResult.turns` field the refusal plan needs — whichever lands first adds it.

### Questions outbox — loops that know when to ask (planned 2026-08-24, refined 2026-08-25,
refined 2026-08-26)

Full plan: [plans/questions-outbox.md](plans/questions-outbox.md). A tracked QUESTIONS.md
(Open/Answered) any loop appends to when a decision is genuinely the user's — context, options,
and the loop's recommendation. Surfaced alongside planned features and open bugs (user note
2026-08-26): an *open questions* section in the GUI project status panel and the TUI Ctrl+T
project-status view, reusing src/backlog.ts's `parseEntries` — superseding the earlier
`/api/questions` panel-on-click design; plus a `questions: N` header badge (count via
StatusSnapshot like inbox). Answers flow back by editing the file or via the director. Loops
never block on their own questions. The report's answer to "software lacks victory conditions":
be excellent at requesting them.

### Steward role — whole-system judgment on a slow clock (planned 2026-08-24, refined 2026-08-25)

Full plan: [plans/steward-role.md](plans/steward-role.md). A markdown-only `steward` role on a
~6 h cadence (per-role `minTickIntervalSeconds` override of the existing global knob) that
re-reads the initial prompt,
PRINCIPLES, PLANS, BUGS, and the codebase's shape, then makes one curation move: prune/merge
plans (the only role allowed to delete entries), flag drift, keep the complexity budget honest.
The tech-lead layer the "projects disintegrate past tens of kLOC" reports say becomes mandatory.

### QA role — exercising the product like a user (planned 2026-08-24, refined 2026-08-26)

Full plan: [plans/qa-role.md](plans/qa-role.md). A `qa` role that follows the README verbatim in
a scratch dir — build, run, curl — one flow per tick, filing reproducible bugs in BUGS.md (its
only write). Hard safety rails: time-limit every process, ephemeral ports, no source edits. The
structural fix for green-suite-but-broken-product (the GUI page incident shipped through 180
passing tests). Self-hosting mechanics decided (2026-08-26): build in its own worktree each tick
and invoke `node dist/cli.js` with cwd = scratch repo; the `run` flow uses either a fake-pi shim
or one real bounded run — the scratch tumwater.json constrained to a single enabled role and
maxConcurrent 1 (a default nested fleet would thrash the shared server's prefix caches), wall-
capped and killed.

### Show timestamp of last result in the GUI/TUI live table (planned 2026-08-21, refined 2026-08-25)

**Goal:** Both live tables — the TUI/one-shot status table and the web GUI loop table — show
when a loop's last result happened as an absolute wall-clock time, not only relative "3m ago".

**Approach:** The data already exists: `LoopState.lastTickEndedAt` (epoch ms) is set at tick end in
`src/loop.ts`, and the GUI's `/api/status` payload (`statusPayload` in src/gui.ts) already exposes
it as `lastTickEndedAt`. This is a rendering-only change; no state or type changes needed.

- TUI/status: extend the existing `last tick` cell (index 7 of the current 9-column table
  `loop state ticks commits gen peak ctx cost last tick last result`) to show both, e.g.
  `14:32:05 · 3m ago` (absolute local time first, relative after). No new column and no
  `FLEXIBLE_COLUMNS` renumbering on this path. (If you instead add a dedicated TUI column,
  note the positional indices in `renderStatus` are currently `{8 = last result, 1 = state}` —
  an earlier draft of this plan said 7/1, before the gen/peak-ctx columns landed; renumber
  accordingly.)
- **Format rule (both surfaces, identical):** local zero-padded `HH:MM:SS`; when
  `now - ts > 86_400_000` ms, prefix `MM-DD ` so multi-day runs stay unambiguous; `-` for loops
  that never ticked. Implement once per surface — a small helper in the table module (TS) and a
  few lines of JS in the page — mirroring the existing `fmtTokens` precedent of formatting at
  each surface rather than shipping pre-formatted strings.
- GUI (`src/gui-page.ts` — all UI edits go there; `gui.ts` only serves): add a `last tick`
  `<th>` inserted between `cost` and `last result` (still adjacent in the current thead, matching
  TUI column order), rendered client-side in `refresh()`'s row builder from `l.lastTickEndedAt`,
  `-` when null. The payload already carries the value; only the `<thead>` row and the row-building
  JS change.
- **Width contract — decided:** add `last tick` as a *third* flexible column, shrunk last (after
  `last result` index 8, then `state` index 1), with `minWidth: 10` (a bare `HH:MM:SS`).
  Rationale: two sibling changes are landing in this same table — the current-work-item plan
  prepends a ~60-char work item into the flexible `state` cell, and the gen/peak-ctx live-awareness
  bug fix rewrites those cells for running loops. With all three in place an 80-col terminal has
  little slack; giving the short, self-evident timestamp column one more degree of freedom (losing
  " · 3m ago" before clipping whole lines) keeps the no-wrap contract cleanest. Keep this change
  orthogonal to both: touch only the `last tick` cell/column and the flexible-column list.
- Files live where you'd expect post-reorg: table rendering, `workingDetail`, `loopPhase`,
  `clipToWidth`, and `FLEXIBLE_COLUMNS` are in **src/status-render.ts** (an earlier draft of this
  plan said src/status.ts — that file now only holds the data-collection `snapshot()`); tests in
  test/status-render.test.ts.

**Files touched:** `src/status-render.ts`, `src/gui-page.ts`, `test/status-render.test.ts` (extend
for the new cell format; add a narrow-width case with the work-item-style wide state cell to prove
the three-column shrink order), and extend `test/gui.test.ts` to assert the served page contains
the new column header.

**Acceptance criteria:**
- TUI and one-shot status show an absolute local timestamp of the last tick end alongside the
  relative age; loops with no ticks yet show `-`.
- GUI loop table has a matching `last tick` column between cost and last result, populated from
  `/api/status`, `-` when null.
- Timestamps use local time; values older than a day include the date (both surfaces).
- Width-awareness preserved: no line exceeds `maxWidth`; at 80 cols with a wide state cell,
  shrink order is last result → state → last tick, and residual overflow still clips cleanly.
- `npm test` passes.

## Done

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
