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
   was — top-N clusters, capped example strings, no raw event dump. The tick prompt is ~8k tokens
   today; the digest must remain a rounding error against it, not a second window filler.
3. **One backwards scan, one home.** The windowed, early-stopping backwards read of events.jsonl
   already exists as `readWindowEvents` in `src/ui/report.ts`. The failure digest imports it
   rather than re-deriving it — one reader of the log's tail, as `parseEventLine` is one parser.
4. **The role writes only BUGS.md**, and only its `## Open` section (plus the normal `_None yet._`
   placeholder handling every filing role performs).
5. **No duplicate filings.** The role checks BUGS.md `## Open` and its own recent commits
   (`git log --grep="tumwater(telemetry)"`) before filing, the same cross-tick memory idiom
   `searchGuidance` gives the backlog-free roles.

## Shape

- `src/ui/failure-report.ts` — new module: `collectFailureReport(root, days)` →
  `FailureReportData`, and `renderFailureMarkdown(data)` → string. Sibling to `report.ts` (which
  keeps usage: tokens, cost, commits) rather than an extension of it — different question,
  different shape, and `report.ts` is already ~250 lines.
- `src/ui/report.ts` — export the existing private `readWindowEvents` (invariant 3). No other
  change.
- `src/cli.ts` — `tumwater report --failures [--days N]`, sharing `REPORT_DEFAULT_DAYS` /
  `REPORT_MAX_DAYS` with the usage report so both surfaces bound the window identically.
- `src/roles.ts` — the `telemetry` role, placed after `qa` in catalog order (both are observers);
  excluded from `DEFERRABLE_ROLES` and from `BASELINE_BLOCKED_ROLES`.
- `src/prompt.ts` — digest injection for the `telemetry` role, beside the existing principles
  injection.
- `src/config.ts` — `roles.telemetry = { enabled: true, minTickIntervalSeconds: 7200 }`.

### What the digest contains

Ordered so the most actionable material is first, since a model reads top-down and the budget is
the bottom of the page:

1. **Header** — window bounds, total ticks, and the source file (`events.jsonl`, rotated at
   16 MB — a window longer than the retained log is reported as partial, never silently short).
2. **Outcome table** — `tick_end` results per role, the exact tally quoted above. One row per
   role, one column per result that occurred in the window.
3. **Deltas vs. the preceding window of equal length** — error rate, quiet-kill count, rejection
   count, per role. This is what makes a *regression* visible; a static 16% error rate reads as
   normal, while "4% → 16% since Tuesday" names a cause. A role absent from the prior window is
   reported as new, not as an infinite increase.
4. **Error clusters** — `tick_end.error` strings normalized and grouped: count, roles affected,
   first and last seen, one verbatim example. Top 10 by count.
5. **Warning clusters** — `warning` events grouped the same way.
6. **Review rejections** — `review_rejected` reasons by role, top 5.
7. **What landed in the window** — `merged` event summaries, newest first, capped at 20, so a
   cluster that starts on a date can be correlated with the commit that starts it. This is the
   single most important field for the role's charter: it turns "errors spiked" into "errors
   spiked right after this commit".

### Cluster normalization

The interesting engineering. A cluster key is the error string with the volatile parts replaced:
hex shas (`[0-9a-f]{7,40}`), absolute paths, standalone integers, ISO timestamps, and durations
(`\d+(\.\d+)?(ms|s|m)\b`) each collapse to a placeholder; the result is trimmed to 120 chars.
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
