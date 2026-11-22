# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

_None yet._

### The steering guide teaches the GitHub-issues mirror loop, so an agent's entry names the issue it mirrors

(planned 2026-11-22 by the plan role)

**Problem.** The GitHub-issues mirror works only if the backlog entry carries one exact phrase: an
issue is mirrored when its `### ` heading carries `mirrors GitHub issue #<n>`
(`mirroredNumbersOf` / `mirrorStates` in src/github/issue-mirrors.ts), and tumwater closes the issue
only once every mirroring entry has reached a finished section (`isFinishedMirror`,
`closeFixedIssues` in src/github/issue-close.ts). Both halves of that contract are taught to the
**director** — src/prompt/prompt.ts's routing bullet for a prompt that opens
`GitHub issue #<n>`, and the same ask in issue-queue.ts's `issueAsk` — but not to the agent that
steers the backlog, which is who writes entries by hand. `tumwater guide` (src/operator/
operator-guide.ts, `GUIDE_BODY`) has seven sections and never mentions GitHub issues at all: it
teaches `## Planned`/`## Open` entry shape without saying that an entry answering a GitHub issue
must name it, and its `Orient first` list reads `status`, `history`, `plan --list`, `bug --list`,
`questions` and `doctor` but never `tumwater issues`, the command that shows what the scan saw and
what tumwater did about each issue. An agent that never learns the phrase leaves the mirror re-
queuing an issue every scan, because `nextIssuePrompt` (src/github/issue-queue.ts) selects only a
trusted open issue that no backlog heading already mirrors.

**Approach.** Two additions to the static body, no new code paths.

- In `GUIDE_BODY`'s `## Orient first` list, one more bullet after the `tumwater doctor` line:
  `tumwater issues` reads the GitHub-issues mirror — the open issues its scan saw and what tumwater
did about each, straight from the ledger file, so an empty read means the mirror is off or has
nothing open.
- One new section, `## Mirroring a GitHub issue`, between `## Writing a bug` and `## Rules`, saying
  four things in the guide's plain terms: the phrase goes in the heading's trailing parenthetical
  and only a `### ` heading counts, so a body that quotes it mirrors nothing; one entry may mirror
  several issues (`mirrors GitHub issues #4, #9`); a series part and a duplicate's survivor each
carry the phrase too, so it survives a split; and tumwater closes the issue itself once every
  mirroring entry sits in a `## Done`, `## Fixed` or `## Verified` section, so the agent never
closes or comments on the issue from the backlog side — while a `retired` entry never closes its
  issue. Put the phrase on its own interpolated constant beside `REQUIRES_CLAUSE`
  (`const MIRROR_CLAUSE = "mirrors GitHub issue #<n>"`) so it sits in the text verbatim the way the
  requires clause does; no `// vocabulary-ok:` comment is needed, since the phrase carries no
  retired word.

**Files touched.** src/operator/operator-guide.ts, test/operator-guide.test.ts, docs/cli.md (the
`Steer from your own agent` row, which lists what the guide covers).

**Acceptance criteria.**
- `tumwater guide` prints a `## Mirroring a GitHub issue` section, and its body contains the literal
  text `mirrors GitHub issue #<n>` and the plural example `mirrors GitHub issues #4, #9`.
- `tumwater guide` prints a `tumwater issues` bullet in `## Orient first`, and the command word in
  that bullet is one `tumwater help` lists — enforced by the existing guide test that extracts every
  backquoted `tumwater <command>` from the printed body and diffs it against `helpStanzas(HELP)`.
- The section-order test sees eight sections with `Mirroring a GitHub issue` between `Writing a bug`
  and `Rules`, and still asserts no `## This project` in the static body.
- The 100-column test passes over the added lines, and the outside-a-repo and half-ready-repo tests
  still see stdout equal to `guideText()` unchanged in shape (they compare against `guideText()`
  itself, so they keep passing as the body grows).
- docs/cli.md's guide row names the GitHub-issues mirror among what the guide teaches.

**Tests.** In test/operator-guide.test.ts, extend `SECTIONS` to the eight headings and assert the new
one lands between `Writing a bug` and `Rules` in `sectionsOf(guideText())` — the order the file
lists, not what the body printed. Add a data test asserting the printed body contains the two
mirroring phrases and a `` `tumwater issues` `` bullet, with the expected strings written out here;
a dropped bullet or a paraphrased phrase (`mirrors issue #<n>`) fails it. No new test file.

## Done
