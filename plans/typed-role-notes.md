# Typed role notes

Planned 2026-11-12 by the operator. One PLANS.md series: "Typed role notes, part i/3".
Companion to plans/since-last-run.md, which explains why runs stay fresh sessions.

## Why

A role's note (`.tumwater/state/notes/<role>.md`, 4 KB cap) is its only memory between runs.
Every `tumwater-notes write` replaces the whole note, so a lesson survives only if the model
copies it forward each time. That is the same failure the compaction research measures:

- *The Compaction Cliff* (arXiv 2608.22752): rules kept 53% after one LLM summarization and
  10% after five, because rules and episode logs are summarized at the same rate. The fix
  ("Knowledge Triage") applies a separate retention rule to each type of line.
- *ACE, Agentic Context Engineering* (arXiv 2510.04618): rewriting a playbook wholesale on
  each step causes "context collapse" and "brevity bias". ACE keeps itemized bullets and
  changes them by small additions and edits instead of full rewrites.

**Measured here 2026-11-12** (75 session transcripts with a note write, all roles, since the
11-12 01:12 session loss):

- Only 16% of a note's paragraphs carry verbatim into the next write, and 41% carry even
  loosely (token Jaccard ≥ 0.4). Notes are mostly rewritten from scratch.
- The plan role's note went from 2,495 bytes (11:33) to 659 (11:49). Its "ruled out" list,
  the candidates it had already measured and rejected, disappeared for three writes and was
  rebuilt by 12:33. That is a lesson lost and then re-learned at the cost of runs.
- Notes mix four kinds of content:
  1. durable lessons: the plan role's "CRITICAL TRAP" about stale worktree indexes, its split
     bar, the feature role's eslint PATH gotcha, selfcheck's rulings;
  2. a log of the last run, usually the largest part;
  3. pointers for the next run;
  4. copies of the backlog, which the prompt already forbids. The feature note's
     "Still open" list is one.

Only the first kind needs to outlive the next rewrite. Today it is rewritten as often as the
log.

## Design

**Two stores.** The existing note stays the log: last run, current state, next step. It is
replaced on every write, exactly as today, with the same 4 KB cap and the same
`tumwater-notes write`. A new lessons file holds durable lessons that tumwater keeps verbatim.
Only an explicit command adds, replaces or retires a lesson.

**Lessons file.** `.tumwater/state/notes/lessons/<role>.md`. It is a subdirectory, so the
notes-dir listing (status-role-notes.ts) never mistakes it for a role. It sits under the
notes directory the write guard already protects. Each line has this form:

    - L7 (2026-11-12): <one lesson, at most 300 bytes>

IDs increase and are never reused. Caps: 12 lessons and 2 KB in total. A full store refuses
`add` and names the retire command, so the cap forces curation instead of silently dropping
old lessons.

**Commands** (src/notes-cli.ts). The lessons path is derived from `TUMWATER_NOTES_PATH`
(`<dir>/lessons/<basename>`), never taken from an argument.

- `tumwater-notes lesson add` reads one lesson from stdin and prints its id.
- `tumwater-notes lesson replace L<n>` reads the amended text from stdin and keeps the id.
  The date becomes today.
- `tumwater-notes lesson retire L<n>` drops it.
- `tumwater-notes lesson list` prints the lessons.
- `tumwater-notes show` prints the lessons, then the note.

**Prompt.** A `<role-lessons>` block goes before `<role-notes>`. Its lead sentence says these
are the role's own earlier conclusions, kept verbatim and dated. It says to check one before
acting on it, and to `replace` or `retire` one that has proved wrong. The note-writing
instruction says what goes where:

- A **lesson** will still be true and useful in a week: a trap and how to avoid it, how to
  verify something, a bar or criterion, a ruled-out candidate with the reason.
- The **note** is this run's state and next step.
- Neither copies the backlog.

notes-backlog.ts's stale-state check reads the lessons as well as the note. One time only,
when a role has no lessons file and a non-empty note, the prompt adds a sentence asking the
run to move any durable lessons from its note into lessons.

**Operator surfaces.** The role view, TUI notes pane and dashboard drawer show the lessons
above the note, read-only. `tumwater role --clear-lessons` empties them. The doctor's
over-cap row covers the lessons file. Renaming a legacy role (legacy-role-migration.ts) moves
the lessons file along with the note.

**Cost.** Up to 2 KB (about 500 tokens) more prompt per run at the cap, before the log
shrinks as lessons move out of it.

## Parts

1. Storage and commands: the lessons path, read/validate/write in role-notes-write.ts, the
   `lesson` subcommands, legacy-role migration. No prompt change, so nothing calls it yet.
2. Prompt: the `<role-lessons>` block, the reworded instruction, the one-time seeding sentence,
   the stale-state check over lessons. Requires part 1 and "Since last run, part 1/1" landed,
   since both edit `runNotesBlocks` and `readPromptNotes`.
3. Operator surfaces, doctor and docs. Requires part 1.

## How we will know it worked

Two weeks after part 2 merges, rerun the 2026-11-12 measurement over session transcripts
(note writes per role, paragraph carry between writes) and add:

- **Lessons:** count per role, adds/replaces/retires per day, and how many roles hit the cap.
  A role that is always full, or never adds a lesson, needs a look.
- **Quality:** sample 20 lessons across roles and classify each as durable or episodic.
  Target: at least 80% durable. Mostly episodic means the instruction wording failed.
- **Re-learning:** count lessons retired and later re-added with the same substance. It
  should be near zero; on the old notes, the plan role's ruled-out list showed the pattern.
- **Note size:** the log should shrink, since durable lessons leave it.
- **Guards:** `no_change` rate, review rejection rate and input tokens per run must not rise
  beyond the ~500-token lessons block.

If weak local models fumble the subcommands (watch exit-1 refusals in transcripts), simplify
to `add` and `retire` before reverting.

## Not in this plan

- Helpful/harmful counters per lesson (ACE). Revisit only if stale lessons show up in the
  quality sample.
- Shared lessons across roles.
- Automatic lesson extraction by the harness. The run decides what is durable, and the
  harness only guarantees it is kept.

## Sources

- The Compaction Cliff: https://arxiv.org/abs/2608.22752
- ACE, Agentic Context Engineering: https://arxiv.org/abs/2510.04618
- Anthropic, Effective context engineering for AI agents (structured note-taking):
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
