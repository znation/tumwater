# Tumwater Role Notes

## feature

<!-- tumwater:begin-slot-notes session=s1-2026-11-09T07:37:40.390Z slot=slot-1 worktree=_slot-1 -->
<!-- 1: Tumwater has assigned you ONE backlog entry from the project backlog. Read the entry's own text (Goal / Approach / Files touched / Acceptance criteria / Tests) in PLANS.md under `## Planned`.
2: The entry's "Files touched" list is the entry's own scope. If you expect to need files outside it, stop and send a director message proposing the expanded scope; otherwise proceed.
3: If the entry's <pending-plans> is non-empty, resolve each named plan now (a named plan.md's decision is that plan; its `## Landed` is the history ledger); if it is empty, resolve each <pending-prs> from its PR body.
4: Implement the entry end-to-end.
5: When you believe the work is complete, run the project's own checks.
6: Only after the project's checks pass: move the entry from `## Planned` to `## Done` under a new `### ` heading, preserving all body content. Add a new Done subheading if `## Done` does not already exist. Add ` — done YYYY-MM-DD by the <role> role` to the heading's end (today's date, your role; if the heading already carries such a stamp, replace it rather than appending a second). Keep the heading text before the stamp identical.
7: Then write your notes for the other roles with your tumwater-notes tool.
8: Then end your reply with a final message to the team of exactly these four labeled lines:
   SUMMARY: <one-line description of what changed>
   WHY: <one sentence on motivation>
   RISK: <one sentence on the most likely risk>
   VERIFIED: <the checks you ran and their outcome> -->

### 2026-11-09 — `backlog --json` rows carry `position`
Gave every `backlog --json` row its 1-based section `position` (the number `plan|bug --list`/`questions` print and `--show/--cancel <n>` take) and kept each kept row's unfiltered position through `--ready`/`--held`/`--grep`. Made `BacklogView` a standalone generic (eslint's `consistent-type-definitions` forced `interface` over `type`), added `positionBacklog`, and positioned in `readBacklog` before filtering so `pickByIndex` keeps the numbers. Text output and the GUI `/api/backlog` payload (`{title, body}`) are unchanged — `positionBacklog` is called only in cli-query-commands. All 6 changed files: backlog-render.ts, cli-query-commands.ts, help.ts, docs/cli.md, test/backlog-render.test.ts, PLANS.md (moved to Done). Gate green (148 affected tests pass, lint clean); the pre-existing INV-BF1 invariants-doc red on main is unrelated and was not chased.

<!-- tumwater:end-slot-notes session=s1-2026-11-09T07:37:40.390Z slot=slot-1 worktree=_slot-1 -->
