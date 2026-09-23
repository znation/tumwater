# Fleet telemetry legibility — a failure digest, and a loop whose job is reading it

Planned 2026-09-17, requested by the user, after
https://blog.detail.dev/posts/towards-self-driving-codebases/ ("agent-legible dev environments":
agents create and miss bugs precisely where they cannot observe). Shared architecture for the two
`Telemetry N/2` entries in PLANS.md; each is independently landable and cross-references this
document.

## The problem

The fleet can read its own source and cannot watch itself run.

Every role prompt in `src/roles.ts` searches the *tree*: `git log --stat`, `wc -l` over sources,
`grep -rn` for a pattern, ranged reads. Not one of them reads `.tumwater/log/events.jsonl`, the
per-role pi transcripts, or `tumwater logs` — `grep -n "events.jsonl\|tumwater logs" src/roles.ts
src/prompt.ts` returns nothing. The harness emits a dense, structured, append-only record of
everything it does and no agent has ever opened it.

The operator has. Counting every attribution in BUGS.md (55 across 24 full entries and the
compressed one-liners, audited 2026-09-17):

| source | bugs found |
| --- | ---: |
| `bugfix` loop (static: grep + ranged reads) | 19 |
| user, reported directly | 10 |
| **human reading the event log** | **8** |
| `readme` loop (doc/code drift) | 7 |
| `coverage`, `plan`, `improve`, `organize` loops | 7 |
| human analysis (unspecified) | 3 |
| `qa` loop | 1 |

Eight bugs came out of the event log; **zero** of them came from a loop. And they are
disproportionately the ones worth having — every one is a defect in how the harness *responds*
to a failure, which no amount of reading source reveals:

- *A broken toolchain is reported as "main is red", and the verdict then latches* (2026-09-15)
- *Repeated tick failures raise no alarm: 44 errors across all 13 loops looked exactly like a
  quiet fleet* (2026-09-15)
- *A tick that fails in 200 ms climbs the idle-backoff ladder: one broken `git` put the whole
  fleet to sleep for hours* (2026-09-15)
- *A rejected `mainGreen` latches a false "main is red" when the redeploy's own git call fails*
  (2026-09-15)

The evidence is sitting there unread. Over the 2026-08-20 → 2026-09-17 window the log holds 1,804
`tick_end` events: 724 `changed`, 485 `no_change`, **295 `error`**, 164 `aborted`, 41
`quiet_killed`, 35 `main_red`, 23 `rejected`, 10 `merge_conflict`, 2 `review_error`, 1
`merge_blocked`. Roughly one tick in six fails, and no loop has ever filed a bug about any of it.

## The decision

Give the fleet an eye on its own runtime, in two pieces: make the evidence cheap to read
(a deterministic digest), then give one role the job of reading it.

**The digest is deterministic, not a model run.** Clustering error strings, counting outcomes and
diffing two windows is arithmetic. Spending a model run to re-derive it every tick would be slow,
non-reproducible, and — with a 27B model behind a finite window — the single most likely way to
reproduce the whole-tree-survey failure that `searchGuidance` exists to prevent. The digest is a
pure function over the event log, unit-tested offline like the rest of the report surface.

**The digest is injected into the prompt, not fetched by the role.** A role runs inside
`.tumwater/worktrees/<role>`, and `.tumwater/` — with the live event log — lives at the *project
root*, one level outside it. The CLI resolves its root from `process.cwd()`, so a role running
`tumwater report` in its own worktree would find no event log at all, and reaching up to the root
checkout would break the rule that a role touches nothing outside its worktree. The harness
therefore renders the digest and appends it to the tick prompt, exactly as every prompt already
carries `PRINCIPLES.md`. The role spends zero tool calls acquiring its evidence and cannot read a
stale or foreign log.

**A cluster is a bug when the harness's RESPONSE to it is wrong — never merely because the
underlying failure happened.** This is the load-bearing prompt rule, and it is derived from the
four human-found bugs above rather than invented: none of them is "pi crashed" or "the model timed
out"; each is "something failed and tumwater handled it wrongly — no alarm, wrong state, wrong
ladder, latched verdict". A digest full of `pi exited null` is infrastructure weather. A digest
showing 44 identical failures that raised no warning is a defect in tumwater. Without this rule
the role would file "the model server was slow" every tick and the backlog would fill with noise
no bugfix run can act on.

**BUGS.md is the role's only write.** Same markdown-only charter as `qa`, and for the same three
reasons: its diffs are review-exempt (`review.exemptPaths` covers `*.md`), so it stays unblocked
while main is red (it is therefore not in `BASELINE_BLOCKED_ROLES`), and a role that both
diagnoses and patches would grade its own homework.

**The role does not defer on an idle backlog.** `DEFERRABLE_ROLES` exists for roles whose input is
the tree: if nothing landed, there is nothing new to organize. The telemetry role's input is the
event log, which grows continuously whether or not main moves — a fleet that is failing while
landing nothing is precisely when it most needs reading. It is therefore outside
`DEFERRABLE_ROLES`, and outside the idle-backoff ladder for the same reason (see
plans/observer-roles.md, which generalizes this to a named `OBSERVER_ROLES` concept; this plan
depends on 1/2 of that series for the scheduling half).

## Invariants

1. **The digest never runs a model.** `collectFailureReport` is a pure function of the event log
   plus a clock; `renderFailureMarkdown` is a pure function of its output. No subprocess, no I/O
   beyond the bounded backwards read the usage report already performs.
2. **The digest is bounded.** Rendered output stays under ~6 KB regardless of how bad the window
   was — top-N clusters, capped example strings, no raw event dump. The Fleet state changes
   section is likewise fixed: at most 6 transition lines, each free field sliced and each line
   capped. The tick prompt is ~8k tokens
   today; the digest must remain a rounding error against it, not a second window filler.
3. **One backwards scan, one home.** The windowed, early-stopping backwards read of events.jsonl
   exists today as `readWindowEvents` in `src/ui/report.ts` and moves to core `src/event-window.ts`
   (Refined 2026-09-18). Both the usage report and the failure digest import it rather than
   re-deriving it — one reader of the log's tail, as `parseEventLine` is one parser.
4. **The role writes only BUGS.md**, and only its `## Open` section (plus the normal `_None yet._`
   placeholder handling every filing role performs).
5. **No duplicate filings.** The role checks BUGS.md `## Open` and its own recent commits
   (`git log --grep="tumwater(telemetry)"`) before filing, the same cross-tick memory idiom
   `searchGuidance` gives the backlog-free roles.

## Shape

- `src/failure-report.ts` — new **core** module (not `src/ui/`): `collectFailureReport(root, days)` →
  `FailureReportData`, `renderFailureMarkdown(data)` → string, and `TELEMETRY_DIGEST_DAYS = 1`
  (the role's window; the CLI keeps 14). It is core because a core consumer — `tickPrompt()` in
  `src/loop.ts` — injects it into the role's prompt, and the README's layering rule (`src/ui/`
  "imported only by each other and `cli.ts`") plus the codebase's zero core→ui imports
  (`grep -rn 'from "./ui/' src/*.ts` names only `cli.ts`) make a core→ui import a violation.
- `src/event-window.ts` — new **core** module: `readWindowEvents` and its `oldestCompleteLine`
  helper move here from `src/ui/report.ts`, along with `REPORT_DEFAULT_DAYS` / `REPORT_MAX_DAYS`,
  and `readWindowEvents`'s return widens to `{ events: HarnessEvent[]; coversFullWindow: boolean }`:
  the flag is true when the backwards scan early-stopped on a line older than the window (proof
  the retained log reaches back past the window's start) and false when it consumed the file's
  start. The caller cannot otherwise tell "the log was rotated inside the window" from "the fleet
  was idle that week" — both leave the oldest returned event later than the window start.
  `src/ui/report.ts` imports the reader and re-exports the two constants (so `cli.ts`'s and the
  tests' imports are unchanged); `collectReport`'s single call site adapts with a destructure (one
  line). Invariant 3's one reader is preserved and both the usage report and the digest share it.
- `src/cli.ts` — `tumwater report --failures [--days N]`, sharing `REPORT_DEFAULT_DAYS` /
  `REPORT_MAX_DAYS` with the usage report so both surfaces bound the window identically.
- `src/roles.ts` — the `telemetry` role, placed after `qa` in catalog order (both are observers)
  and before `improve`; `OBSERVER_ROLES` gains `"telemetry"`. `DEFERRABLE_ROLES` and
  `BASELINE_BLOCKED_ROLES` already exclude it by construction — no code change — but
  `test/roles.test.ts`'s `exempt` set and observer message must be updated.
- `src/prompt.ts` — `TickPromptInput` gains `digest?: string`; `buildTickPrompt` renders it as a
  `<failure-digest>` block beside the `<principles>` block.
- `src/loop.ts` — `tickPrompt()` computes the digest via `collectFailureReport` +
  `renderFailureMarkdown` only when `this.role === "telemetry"`, reading `this.root` (the project
  root where `events.jsonl` lives, not the worktree); a throw omits the block and never fails the
  tick.
- `src/config.ts` — `roles.telemetry = { enabled: true, minTickIntervalSeconds: 7200 }`.

### What the digest contains

Ordered so the most actionable material is first, since a model reads top-down and the budget is
the bottom of the page:

1. **Header** — window bounds, total ticks, and the source file (`events.jsonl`, rotated at
   16 MB). A window longer than the retained log is reported as partial, never silently short:
   when `coversFullWindow` is false and events exist, one header line reads
   `partial: retained log starts <oldest event's local date>` (the date from the returned events'
   minimum `ts`); an empty log reads `no events retained` instead, and is not called partial —
   there is nothing to compare against.
2. **Fleet state changes** — the harness's own decisions in the window, newest `STATE_CHANGE_TOP`
   kept in chronological order, each as `MM-DD HH:MM <role> — <payload>`: the `budget_*`,
   `fleet_*`, `max_concurrent_changed`, `retention_changed`, `config_changed`, `build_stale`,
   `restart_pending`, `restart`, `tick_deferred`, and `orchestrator_*` transitions. This is the
   evidence the "response was wrong" rule needs, so it reads before the counts. Every free field
   is sliced (`STATE_CHANGE_FIELD_MAX`) and each line capped (`STATE_CHANGE_MAX`), making the
   section a constant; a window with none omits it. (Added 2026-09-21 — it was omitted before,
   see BUGS.md's failure-digest entry.)
3. **Outcome table** — `tick_end` results per role, the exact tally quoted above. One row per
   role, one column per result that occurred in the window. Fields: `tick_end.loop` (the role,
   `"?"` when empty — `collectReport`'s guard) and `tick_end.result`.
4. **Deltas vs. the preceding window of equal length** — error rate, quiet-kill count, rejection
   count, per role. This is what makes a *regression* visible; a static 16% error rate reads as
   normal, while "4% → 16% since Tuesday" names a cause. A role absent from the prior window is
   reported as new, not as an infinite increase. **One scan, not two**: read the 2× window once —
   `readWindowEvents(root, formatDate(dayAt(2 * days - 1)))`, the same local-midnight `dayAt`
   idiom (`setDate` arithmetic) and `formatDate` (src/text.ts) `collectReport` uses — and
   partition in memory by local date: the current window is `date >= formatDate(dayAt(days - 1))`,
   the preceding window is the earlier dates in that same read. A second call would double the
   tail I/O invariant 3 exists to bound.
5. **Error clusters** — `tick_end.error` strings (a string, absent on ticks that set no error —
   skip those) normalized and grouped: count, roles affected, first and last seen, one verbatim
   example. Top 10 by count.
6. **Warning clusters** — `warning.message` grouped the same way (harness-scoped warnings carry
   `loop: "harness"`; no special case needed).
7. **Top rejection clusters** — `review_rejected.reasons` by role, top 5, clustered on `reasons[0]`
   (the same field the event feed renders, src/ui/event-format.ts), so a digest line reads like a
   `tumwater logs` line; when more than 5 clusters exist the section ends with a `_+N more clusters
   holding K rejections_` line whose K equals the Deltas table's rejections column, so the cut is
   visible and cross-checkable (BUGS.md 2026-09-22).
8. **What landed in the window** — `merged.summary` (with its `commit`) newest first by `ts`,
   capped at 20, so a cluster that starts on a date can be correlated with the commit that starts
   it. This is the single most important field for the role's charter: it turns "errors spiked" into
   "errors spiked right after this commit".

### Cluster normalization

The interesting engineering. A cluster key is the error string with the volatile parts replaced,
rules applied in this order: hex shas (`[0-9a-f]{7,40}`), absolute paths, ISO timestamps,
durations (`\d+(\.\d+)?(ms|s|m)\b`), then standalone integers — each collapses to a
placeholder; the result is trimmed to 120 chars. The integer rule carries one exception, or it
would erase the very distinction the next sentence requires: `\b\d+\b` collapses with a
negative lookbehind, `/(?<!exited\s)\b\d+\b/g`, so the exit status after `exited ` survives.
`pi exited null` and `pi exited 1` stay distinct (the exit code is semantic); `ENOENT
/Users/zach/tumwater/.tumwater/worktrees/dry/foo.ts` and the same under `clean/` collapse to one.
Deliberately conservative: over-clustering hides a real second failure mode, while
under-clustering merely costs a row. Its own unit tests, with the real 2026-09 error strings from
the log as fixtures.

## Sequencing

1. **1/2 — the digest.** `collectFailureReport` + `renderFailureMarkdown` + the CLI flag. Lands
   alone, with no role and no prompt change: the operator gets the tool they have been
   approximating by hand, and the pure functions are fully tested before anything consumes them.
2. **2/2 — the role.** The `telemetry` role, its prompt injection, its config default, README.
   Depends on 1/2, and on plans/observer-roles.md 1/2 for the non-deferring, non-backing-off
   scheduling; without that the role would climb the idle ladder to a 10-hour sleep after eight
   quiet ticks, which is exactly the starvation that made `qa` useless.

## How we will know it worked

The post's own framing: agent-readiness is measurable or it is an art. The metric here is
**bugs filed by `telemetry` that a `bugfix` tick later lands a fix for**. The baseline is
explicit and damning — 0 of 55 recorded bugs came from a loop reading runtime evidence, against 8
found by a human doing it by hand. If after a month the role has filed nothing actionable, the
digest is the wrong shape and this plan failed; if it approaches the human's rate, the fleet has
acquired a sense it did not have.

## Deliberately out of scope

- **A JSON form of the digest, or a GUI tab.** The consumer is a model reading Markdown and an
  operator reading a terminal. `/api/report` and the GUI charts serve the usage report; adding a
  second surface before the digest's shape has settled would pin a shape we will want to change.
- **Reading the per-role pi transcripts.** `.tumwater/log/*.pi.jsonl` runs to ~90 MB — 17 MB for
  `feature` alone. There is real signal in them (which tool call stalled, what the model was
  doing when the window filled) but extracting it is a separate plan with its own bounded-read
  design, and events.jsonl is the cheap 90% first.
- **Acting on the diagnosis.** The role files bugs; `bugfix` fixes them. A role that patched what
  it diagnosed would bypass the division that makes both trustworthy.
- **Alerting.** The harness already warns on an error streak (`ERROR_STREAK_WARN`). Turning digest
  clusters into live events is a plausible follow-on and not part of this.

## Refined 2026-09-18 (plan loop) — 2/2 audited against main `833cabf`

The entry was created 2026-09-17 and had never been audited (1/2 was refined that day; the tree
is now `833cabf` and none of the landings since the README's stamp touches this plan's anchors).
The audit found one design defect and pinned five seams; the Shape bullets above are corrected in
place. Verified anchors: `TickPromptInput` at src/prompt.ts:142 and
`buildTickPrompt` at :163; `tickPrompt()` at src/loop.ts:144, which reads `readPrinciples` from
core prompt.ts (so a core digest function is the only clean injection); the `qa` catalog entry at
src/roles.ts:185–195 with `improve` at :196; `OBSERVER_ROLES` at src/roles.ts:274;
`DEFERRABLE_ROLES` at :282 and `BASELINE_BLOCKED_ROLES` at :312; `roles.qa`'s clock at
src/config.ts:21; the observer no-backoff arm at src/state.ts:217; `"*.md"` in
`review.exemptPaths` at src/config.ts:61; the exact-set catalog assertion and `exempt` set at
test/roles.test.ts:44–62; the slow-clock assertion and its `continue` list at
test/config.test.ts:36–52.

**Defect.** 2/2 injects the digest in `tickPrompt()`, which is core; 1/2 placed the digest in
`src/ui/failure-report.ts` and left the reader in `src/ui/report.ts`. Core→ui has no precedent
(only `cli.ts` imports `src/ui/`), so the injection as written would either violate the
presentation-layer boundary or duplicate the log reader. Resolved by the core placement in the
Shape section above.

**Pinned seams.** (1) Injection: `TickPromptInput.digest?: string`, a `<failure-digest>` block in
`buildTickPrompt`, set only for `this.role === "telemetry"` from `this.root`, inside a try/catch
(a corrupt log omits the block, never fails the tick). (2) Window: `TELEMETRY_DIGEST_DAYS = 1`
for the role, distinct from the CLI's 14 — a two-week block re-surfaces the same clusters every
tick. (3) Catalog: insert after `qa`/before `improve`, add to `OBSERVER_ROLES`; update
test/roles.test.ts:50's `exempt` set (the assertion is exact) and the observer message at :67.
(4) Config: assign `roles.telemetry` beside `roles.qa` (src/config.ts:21) and add `"telemetry"`
to test/config.test.ts:47's `continue` list. (5) Tests: test/roles.test.ts, test/prompt.test.ts,
test/config.test.ts; BUGS.md-only diffs are already exempt via `"*.md"`, and the generic
no-backoff behavior needs no loop test. No design question remains open.

## Landed 2026-09-18 (feature loop) — 1/2 only; 2/2 still planned

The digest and the CLI flag are in. `src/failure-report.ts` (core) holds
`collectFailureReport` / `renderFailureMarkdown` / `normalizeClusterKey` /
`TELEMETRY_DIGEST_DAYS = 1`; `src/event-window.ts` (core) holds the moved windowed tail read
and the `REPORT_*_DAYS` bounds, now returning `{ events, coversFullWindow }`; `src/ui/report.ts`
imports the reader and re-exports the constants; `src/cli.ts` adds the valueless `--failures`
flag. `test/failure-report.test.ts` is new. `npm test`: 1,118 pass.

Five decisions the implementation pinned, recorded so the plan matches the code:

1. **`coversFullWindow` means "the retained log reaches back before the window."** That is the
   early stop *or*, when the whole log fit in one chunk, the file's own oldest line — because
   `oldestCompleteLine` always discards the earliest chunk's first line, a one-chunk log would
   otherwise read as uncovered. The reader's and the interface's docs say exactly this.
2. **Caps tightened to hold invariant 2.** Measured on the live log: 5,554 bytes at the default
   14 days, 5,562 at `--days 90`. To keep that under 6 KB the caps are 7 error clusters (not 10),
   7 warning clusters (not 10), 5 rejections, 10 landed commits (not 20), examples trimmed
   120 chars / landed summaries 100, cluster role lists at 4 names plus `+N more`, and dates as
   `MM-DD`. The output therefore does not grow with how bad the window was.
3. **No combined failure-result set.** Section 3's delta line reports the three named metrics
   (error rate, quiet kills, rejections) directly, so no set's doc comment can drift from its
   behavior. This supersedes the draft's `FAILURE_RESULTS`, whose comment had said operator
   kills counted while the set excluded `user_aborted` and included the shutdown `aborted`.
4. **The result vocabulary is closed by the type checker.** `RESULT_ORDER` is a
   `Record<TickResult, number>`, so adding a `TickResult` without a column is a compile error;
   `queued`, `skipped`, `user_aborted` and the rest are present.
5. **Rejections cluster on `(role, reasons[0])`**, keyed on the role plus the normalized message,
   so two distinct rejection reasons from one role stay separate rows — the same
   `reasons[0]` the event feed renders.

Three header states, not two: `no events retained` (an empty/torn log), `no events in the last
N days` (the retained log reaches back before the read span but holds nothing in it), and
`partial: retained log starts <date>` (the window begins before the retained log does).
