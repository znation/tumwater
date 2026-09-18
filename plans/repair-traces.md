# Repair traces — record what made each bug hard to validate

Planned 2026-09-17, requested by the user, after
https://blog.detail.dev/posts/towards-self-driving-codebases/. The post's bootstrap methodology
is three steps: mine a codebase for bugs, fix them, and *use the traces from fixing them to
prioritize the work that makes the codebase more amenable to agents*. tumwater does the first two
and throws away the third. One independently landable entry in PLANS.md.

## The problem

A BUGS.md `## Fixed` entry records the symptom, the reproduction, the cause and the fix. Nothing
anywhere records **what made the bug hard to confirm** — whether the loop could reproduce it
deterministically, whether it had to stand up a fake that did not exist, whether it had to do an
expensive real bounded run because no offline path covered the area, whether it had to read three
modules before it could tell what the invariant even was.

That missing field is the only evidence that would say where the project's own test
infrastructure is weakest, and without it the fleet's investment in its own testability is
guesswork:

- The `coverage` role picks its target by a structural proxy — "a module with no test file is the
  first candidate", or the file with the most uncovered lines. Both are reasonable priors and
  neither is evidence. A module with 95% line coverage and no way to exercise its concurrent path
  is invisible to both, and that is exactly the shape of the harness's hardest bugs (the landing
  race, the latching `mainGreen`, the torn trailing line).
- The `plan` role has no input at all on testability. It plans features.
- The harness already measures *authoring* friction — `highFriction` in `src/loop.ts`, flagged
  past turn and wall-clock thresholds and stamped into the commit trailer — but that says a tick
  was expensive, not why, and it is attached to the commit rather than to the bug. It is a
  symptom detector with no diagnosis attached.

So the fleet repeatedly pays the same validation costs and has no way to notice it is paying
them. This is the cheapest of the three post-derived plans to land and the one that compounds:
every fix from here on deposits a little evidence about the environment it was fixed in.

## The decision

One line in the Fixed-entry template, written by the `bugfix` role at the moment it has the
knowledge — immediately after confirming its own fix — and harvested by the `steward`.

**A closed tag plus free text.** The line reads:

```
**Validation gap:** <tag> — <one sentence>
```

with `<tag>` drawn from a fixed vocabulary:

| tag | means |
| --- | --- |
| `none` | reproduced and verified with the existing suite; nothing was missing |
| `no-repro` | could not reproduce deterministically; the fix rests on reasoning, not a red test |
| `no-fake` | needed a fake/shim for something that had none, and wrote one (or worked around it) |
| `real-run-needed` | no offline path covered the area; required a real bounded run |
| `no-observability` | the failure left no trace — had to add logging or instrument to see it |
| `slow-check` | the only available verification was slow enough to shape how the fix was made |
| `unclear-invariant` | had to reconstruct what the code was *supposed* to guarantee before fixing |

The closed vocabulary is the whole point: free text alone is unaggregatable, and a tally is what
turns anecdote into a priority. `grep -o 'gap: [a-z-]*' BUGS.md | sort | uniq -c` is the entire
query surface, which suits both a mid-sized local model and an operator at a terminal. The free
text after the em dash is what makes an individual entry actionable; the tag is what makes a
hundred of them countable.

**`none` is mandatory, not optional.** A missing line is indistinguishable from a role that
forgot, so the template requires the line with `none` as an explicit value. That keeps the
denominator honest — "4 of 12 recent fixes hit `no-repro`" is a claim; "4 entries mention
`no-repro`" is not.

**The steward promotes, the bugfix role only records.** Recording is cheap and local to the run
that has the knowledge. Deciding that three `no-repro` entries justify a plan for deterministic
concurrency fixtures is a whole-system curation judgment, which is the steward's existing
charter — it already curates both backlog files and already writes PLANS.md notes. This becomes
one more move in its list: when three or more retained Fixed entries carry the same non-`none`
tag, write a PLANS.md entry for the infrastructure investment that would retire it, citing the
entries. One curation move per tick still holds.

**Compression must not eat the evidence.** The steward compresses Fixed entries past the ten most
recent to a single line, and that line drops the body — including this one. A tag would therefore
have a ten-entry shelf life, which is shorter than the interval over which a pattern becomes
visible. So the compressed form gains a suffix:

```
- <symptom headline> (<date clause>; commit <sha>; gap: <tag>)
```

Bounded (one short token), greppable by the same query as the full form, and omitted entirely
when the tag is `none` so the common case costs nothing. The full sentence is lost to git history
on compression, which is the same deliberate lossiness the existing compression policy accepts.

## Invariants

1. **`bugfix` records, never promotes.** Writing the line is part of closing an entry; it never
   spends extra tool calls investigating the gap, and it never writes to PLANS.md.
2. **The vocabulary is closed and lives in one place** — `src/roles.ts`, embedded in both the
   `bugfix` find text and the `steward` compression rule from a single exported constant, so the
   two cannot drift. A gap that fits no tag uses the closest one and says so in the free text;
   adding a tag is a deliberate edit, not a role's improvisation.
3. **No new file, no new state.** The trace lives in the BUGS.md entry it belongs to. A separate
   ledger would need its own curation policy and its own staleness story, and would separate the
   evidence from the bug that produced it.
4. **`none` entries stay silent after compression.** The suffix appears only for a real gap, so
   the compressed Fixed section does not grow measurably.

## Shape

- `src/roles.ts`
  - a `VALIDATION_GAP_TAGS` constant and a shared `VALIDATION_GAP_GUIDANCE` fragment (the same
    define-once pattern as `DECOMPOSITION_GUIDANCE` and `PLAN_SIZING`, which two role texts
    already embed).
  - `bugfix.find` — the Fixed-entry instruction gains the required line.
  - `steward.find` — the BUGS.md compression rule gains the `gap:` suffix clause, and the
    curation-move list gains gap promotion.
- `src/init.ts` — `BUGS_TEMPLATE`'s guidance line mentions the field, so a fresh project starts
  with the convention rather than acquiring it.
- `test/roles.test.ts` — assert both role texts embed the shared constant, and that every tag in
  the vocabulary appears in the guidance.
- README — one sentence in the how-it-works description of the bugfix/steward pair.

No source behavior changes: this is prompt and template work, plus the tests that pin it. That is
what makes it one run.

## How we will know it worked

After ten or so fixes, `grep -o 'gap: [a-z-]*' BUGS.md | sort | uniq -c` returns a distribution
rather than nothing. The success condition is not a particular shape — it is that the question
"where is this project hardest to verify?" becomes answerable from the repo instead of from
memory. The first PLANS.md entry the steward writes off a tag cluster is the point at which the
loop closes: a bug fixed → a gap recorded → a pattern noticed → infrastructure planned → the next
bug in that area cheaper to confirm.

## Deliberately out of scope

- **Inferring the gap automatically** from turn counts, tool calls or `highFriction`. Those
  measure effort, not cause; a 40-turn tick might have been a hard reproduction or a wide
  refactor. The role that just did the work knows which, and asking it costs one line.
- **The same field on PLANS.md Done entries.** Feature work has a different difficulty profile
  and the evidence would not pool with bug-fix traces. Worth revisiting once the bug side has a
  distribution to look at.
- **Changing how `coverage` picks its target.** The obvious follow-on is to point it at the
  modules named in `no-fake` / `no-repro` traces, but that should wait until there are enough
  traces to point at anything. Recording first, consuming second.
- **A `gap:` tally on the dashboards.** A grep is enough until it is not.
