# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

### `tumwater reviews`, its `--show` detail and the dashboard's Post-merge reviews card name a queued
  commit's live provider-failure backoff, so an entry that is not moving is told apart from one that is
  simply waiting (planned 2026-11-23 by the plan role)

**Why:** a post-merge review that ends on a transient provider failure is deliberately kept and left
*uncounted* — INV-BT5 forbids incrementing `failures` or filing a bug for it — and the drain stamps its
`notBeforeMs` deadline and skips the entry until that passes (INV-BT6; `unreviewed`,
src/merge/merge-post-review-drain.ts). Nothing an operator reads says any of that: `postReviewStatusLabel`
(src/review/post-merge-review-render.ts) labels an entry `failing` only when `failures` is positive, so a
wall-fed entry renders as a plain `waiting` row — `1. improve a1b2c3d4 · 2h ago · add the parser` with no
bracketed suffix at all — on `tumwater reviews` (list and `-f/--follow`), in `--show`, and on the dashboard's
Post-merge reviews card. During the 2026-11-16 quota wall that is exactly the state the backoff was added
for (BUGS-FIXED.md "A post-merge review that ends on a transient provider failure is retried every poll,
with no backoff and no limit", fixed 2026-11-17), and the fixer changed only the drain: `grep -rn
notBeforeMs src/ui src/cli src/doctor` names no post-review consumer (its only hit,
src/ui/gui/gui-client-backlog.ts, is a queued inbox prompt's `delivers in` clause) — the field rides the
`postReviews` payload (src/ui/status-payload.ts spreads every field but `body`) and the normalized entry,
and then nothing reads it. The merge queue already shows its own deferral this way (` · eligible in
<duration>`, `queueEntryLineHtml`, src/ui/gui/gui-client-pending.ts), so the vocabulary exists to copy.

**Approach:** one exported note function in the renderer, rendered as a bracketed suffix by the CLI list
and the card and as a plain line by the detail view. Nothing changes in src/merge/ or src/review/post-merge-review.ts:
the backoff, its escalation and its skip rule stay as INV-BT5/BT6 pin them; this only reads `notBeforeMs`
and `consecutiveTransientFailures` where the other entry facts are already read.

1. src/review/post-merge-review-render.ts: add `export function postReviewBackoffNote(entry: PostReview,
   now: number): string`. It returns `""` unless `typeof entry.notBeforeMs === "number" && entry.notBeforeMs > now`
   — a *live* wait — and otherwise `provider backoff — retrying in <duration>`, the duration from
   `humanUntil(entry.notBeforeMs, now)` (src/text/datetime.ts, the same `humanSeconds`/`secondsUntil`
   bucketing every other countdown in the harness uses; `humanAgo` is already imported there). A deadline
   already passed renders nothing: the drain admits the entry on the next poll, so there is no wait to
   name, and the list line stays byte-identical to today's. Do not fold it into `postReviewStatusLabel` —
   that switch picks one label by precedence and an entry can hold a content-failure `failures` count *and*
   a transient-failure deadline at once (the infrastructure settle spreads `...entry`, keeping `failures`).
2. Same file, `renderPostReviews`: beside the existing `suffix` (the ` · [label]` the status label
   produces), build `backoff` under the same `typeof now === "number"` guard the existing `age` clause uses
   (the list is callable without a clock) — `""` when the note is empty, else `` ` · [${note}]` `` — and
   append it after `suffix` on the entry line, so an entry without a live wait renders exactly as before. The list already takes `now` (its only clock input, `Date.now()` from
   `cmdReviews`, re-read per `-f/--follow` frame), so the countdown ticks with no new plumbing.
3. Same file, `renderPostReviewDetail`: after the `Failed review runs:` / `Last failure:` block and before
   `Fixed in:`, push `Provider backoff: retrying in <duration>` (the same note minus its `provider backoff — `
   lead, from `humanUntil`) when the live-wait condition holds, and a separate line
   `Transient provider failures in a row: <n>` when `typeof entry.consecutiveTransientFailures === "number"`
   and it is positive — the streak is what says the pause has already doubled toward its cap. Keep the
   detail view untruncated, as its doc comment requires.
4. src/ui/gui/gui-client-pending.ts, `postReviewsHtml`: inside the row builder, beside the existing `label`
   clause, build `const backoff = Number.isFinite(e.notBeforeMs) && e.notBeforeMs > now ? " · <span class='mono'>[provider backoff — retrying in " + esc(humanSeconds(secsUntil(e.notBeforeMs, now))) + "]</span>" : ""` and splice it after the status-label span. The browser bundle has no `humanUntil`, so the twin composes
   `humanSeconds(secsUntil(…))` exactly as `queueEntryLineHtml`'s `eligible in` clause does; `humanSeconds`
   and `secsUntil` are already in the `format` region, which the pending-table tests load.
5. src/cli/cli-help-text.ts, the `tumwater reviews` stanza: after the failed-review-run-count clause, say
   that an entry inside a transient-provider-failure backoff also carries `[provider backoff — retrying in
   <duration>]` while that wait holds, and that `--show` names the wait and the consecutive-failure streak.
6. docs/cli.md, the Check state row's `tumwater reviews` clause: same sentence in prose — the list names a
   live provider backoff, `--show` names it whole with the streak. docs/how-it-works.md, the Post-merge
   reviews card sentence ("each with its rejected … or failed-review status"): add that a row also names a
   live provider-failure backoff and its countdown, the browser twin of the list's bracket.
7. docs/invariants.md INV-BT6's **Binds.** gains `src/review/post-merge-review-render.ts`
   (`postReviewBackoffNote`) and `src/ui/gui/gui-client-pending.ts` (`postReviewsHtml`) as readers of
   `PostReview.notBeforeMs`, so the field's meaning keeps one home; its **Guarantee.** and **Pinned by.**
   sentences stay as they are (the drain's selection is unchanged), and INV-BT5 is untouched.

**Files touched:** src/review/post-merge-review-render.ts, src/ui/gui/gui-client-pending.ts,
src/cli/cli-help-text.ts, docs/cli.md, docs/how-it-works.md, docs/invariants.md,
test/post-merge-review-render.test.ts, test/cli-reviews.test.ts, test/gui-client-pending.test.ts.
No change to src/merge/merge-post-review-drain.ts, src/review/post-merge-review.ts, or
src/ui/status-payload.ts — the backoff, its writer and the payload stay as they are, so `--json` keeps its
exact current shape. Independent of the one open BUGS.md entry (in flight by bugfix-2, src/runner,
src/scheduling, src/git, src/run) and of every `## Planned` sibling — `## Planned` holds no other entry and
`grep -n 'post-merge-review-render\|gui-client-pending' PLANS.md BUGS.md` matches nothing outside this entry.

**Acceptance criteria.**
- `postReviewBackoffNote(e({ notBeforeMs: now + 600_000 }), now)` answers exactly
  `provider backoff — retrying in 10m`; `postReviewBackoffNote(e({ notBeforeMs: now - 1 }), now)`,
  `postReviewBackoffNote(e({}), now)` and a bare `notBeforeMs: now` all answer `""`.
- `renderPostReviews([e({ notBeforeMs: <render now> + 600_000 })], undefined, <render now>)` prints the
  entry line ending ` · [provider backoff — retrying in 10m]`; the same entry with `notBeforeMs: <render
  now> - 1` and an entry without the field print lines byte-identical to today's (the existing
  "an entry with neither rejected nor failures carries no suffix" test stays green). An entry carrying both
  `failures: 2`/`lastFailure: "boom"` and a live deadline prints both brackets — the failed-run label and
  the backoff — in that order, proving the note is not part of the status-label switch.
- `renderPostReviewDetail(e({ notBeforeMs: now + 90_000, consecutiveTransientFailures: 3 }), 1, now)`
  contains the lines `Provider backoff: retrying in 2m` and `Transient provider failures in a row: 3`;
  the same entry with `consecutiveTransientFailures: 0` prints the backoff line and no streak line, and an
  entry with no `notBeforeMs` prints neither (the existing "adds each optional block only when its field is
  present" test stays green).
- Spawned `tumwater reviews` in a repo whose `.tumwater/state/post-review.json` holds one entry with
  `notBeforeMs: Date.now() + 600_000` exits 0 and its stdout matches
  `\[provider backoff — retrying in 10m\]`; `tumwater reviews --json` on the same file prints a `pending`
  row whose `notBeforeMs` equals the seeded number and which carries no new key.
- `postReviewsHtml([{ role: "feature", commit: "abcdef1234567890", summary: "x", notBeforeMs: now + 42_000 }],
  "", "", "", now)` contains `[provider backoff — retrying in 42s]` and the same entry without `notBeforeMs`
  contains no `provider backoff` text (explicit `now` argument, as the state-picker test already passes).
- `node scripts/tsc.mjs --incremental`, the four named test files, and check-permit over backlog-structure
  plan-citations backlog-eligibility invariants-doc cli-doc stay green.

### A role whose lessons store has outgrown its caps raises a standing amber alert on
  `tumwater status` and the dashboard, the twin of the doctor `role notes` row's lessons clause
  (planned 2026-11-23 by the plan role)

**Why:** the lessons store is capped on the write side only. `ROLE_LESSONS_MAX_COUNT = 12` /
`ROLE_LESSONS_MAX_BYTES = 2048` (src/roles/role-notes-write.ts) are enforced by the `add` path, so a hand
edit or an older build leaves a store past them and that role's next `tumwater-notes lesson add` is
refused. That state has exactly one surface today: `tumwater doctor`'s `role notes` row
(src/doctor/doctor-role-notes.ts's `checkRoleNotes`), whose lessons clause reads
`N lessons file(s) across N role(s) exceed(s) the 12-lesson / 2048-byte store caps: <role> (<n> lessons, <b> bytes) —
a role's own lesson add will now be refused until one is retired (…)`. The notes half of that same row has
a standing twin — the amber `role-notes-truncated` alert raised by `pushRoleNotesAlert`
(src/ui/team-alert-standings.ts) from the `roleNotesOverCap` snapshot array — but the lessons half has
none, so an operator who never runs `tumwater doctor` learns about a store that has stopped learning only
from a refusal in a role's output. Both halves come from readers in one file
(src/status/status-role-notes.ts) that `checkRoleNotes` already calls together, so the twin costs one
snapshot key and one arm.

**Approach:** mirror the note twin exactly, reusing its arm and the doctor row's own sentence.

- src/status/status-role-notes.ts: export the entry type now kept private (`RoleLessonOverCap`: `role`,
  `bytes`, `lessons`) and add `collectRoleLessonsOverCap(root)` returning `readRoleLessonsOverCap(root)`
  unchanged, beside the existing `collectRoleNotesOverCap`. Leave the lessons reader uncached: it walks one
  small `.md` per role in a directory the role count bounds, and it counts lessons by scanning the text, so
  the size-keyed `cachedByStat` (src/files/stat-cache.ts) would miss on every lesson edit anyway. A missing
  or unreadable lessons dir already reads `[]` there — no new state to handle.
- src/status/status-types.ts: add `roleLessonsOverCap?: RoleLessonOverCap[]` beside `roleNotesOverCap`
  (which the file already imports), documented as absent when empty.
- src/status/status-data.ts: where `collectRoleNotesOverCap(root)` is already called once per poll, call the
  lessons collector beside it and pass it as a parameter to `snapshotHealthFields`, which already takes
  `roleNotesOverCap`; emit it in that builder's returned object as
  `...(roleLessonsOverCap.length > 0 ? { roleLessonsOverCap } : {})`.
- src/ui/status-payload.ts: pass the key through in the raw `--json` object beside `roleNotesOverCap`, as an
  array of `{ role, bytes, lessons }` in the reader's descending-byte order.
- src/ui/team-alerts.ts: add `"roleLessonsOverCap"` to the `Pick<StatusSnapshot, …>` union of standing flags
  that already names `"roleNotesOverCap"`.
- src/ui/team-alert-standings.ts: add `pushRoleLessonsAlert(out, over, root)` beside `pushRoleNotesAlert`,
  raising through the shared `pushDoctorTwinAlert` so the detail is `checkRoleNotes(root)`'s warn sentence
  whole and the alert and the row stay twins by construction; title
  `N role(s) over the 12-lesson / 2048-byte lessons caps` built with `plural(over.length, "role", "roles")`
  (the snapshot array's length, as the note arm does, because the row's own named cap undercounts past
  three roles). Emit it in `buildStandingAlerts` immediately after the `roleNotesOverCap` arm, gated by
  `snap.roleLessonsOverCap && snap.roleLessonsOverCap.length > 0`. Update that module's header comment and
  `buildStandingAlerts`'s emission-order comment.

**Files touched:** src/status/status-role-notes.ts, src/status/status-types.ts, src/status/status-data.ts,
src/ui/status-payload.ts, src/ui/team-alerts.ts, src/ui/team-alert-standings.ts (the last three are the alert
builder and payload, which live under src/ui/, not src/status/);
test/status-role-notes.test.ts, test/team-alerts.test.ts, test/status-payload.test.ts;
docs/invariants.md (INV-T6), docs/cli.md (the `tumwater status` Check state row), docs/how-it-works.md (the
alerts list naming the standing doctor twins). No dashboard client change: the alerts band renders the
payload's `alerts` array, which already carries whatever `teamAlerts` raises.

**Acceptance criteria:**

- With a `.tumwater/state/notes/lessons/feature.md` holding 13 `- L<n> (<date>):` lines under the byte cap,
  `tumwater status` shows a standing amber alert and `tumwater status --json` carries a
  `roleLessonsOverCap` array whose single row is `{ role: "feature", lessons: 13, bytes: <file bytes> }`;
  the same file at 12 lessons carries neither the key nor the alert.
- The alert's detail is byte-identical to the `role notes` row's detail from `checkRoleNotes(root)` in the
  same tree — the plan pins the twin, not new wording — so the row's lesson count, byte count and the
  `tumwater-notes lesson retire` / `--clear-lessons` remedy appear in the standing alert. The `role notes`
  row's own output is unchanged (the existing `checkRoleNotes` lessons tests in test/doctor-checks.test.ts
  pass untouched).
- With no lessons dir at all, and with a lessons file inside both caps, `tumwater status --json` has no
  `roleLessonsOverCap` key and no `role-lessons-over-cap` alert (the absent store is not an alert), and the
  existing standing-alert cases in test/team-alerts.test.ts stay green.
- An over-cap lessons file alone (no over-bound note) raises only `role-lessons-over-cap`; an over-cap note
  alone raises only `role-notes-truncated`; both at once raise both, note first then lessons, and both alerts
  carry the one joined `checkRoleNotes` sentence — the behaviour `role-notes-truncated` has today.
- docs/invariants.md INV-T6 is updated in the same commit: the standing doctor-twin family is eight alerts
  including `role-lessons-over-cap`, its flag list names `roleLessonsOverCap`, the amber count goes from six
  to seven, and its **Binds**/**Pinned by** paragraphs name the new arm and tests.
- `node scripts/tsc.mjs --incremental`, then the runner over status-role-notes team-alerts status-payload
  doctor-checks backlog-structure plan-citations invariants-doc cli-doc config-doc, stay green.

### `tumwater reviews`, its `--show` detail and the dashboard's Post-merge reviews card name a queued
  commit's live provider-failure backoff, so an entry that is not moving is told apart from one that is
  simply waiting (planned 2026-11-23 by the plan role)

**Why:** a post-merge review that ends on a transient provider failure is deliberately kept and left
*uncounted* — INV-BT5 forbids incrementing `failures` or filing a bug for it — and the drain stamps its
`notBeforeMs` deadline and skips the entry until that passes (INV-BT6; `unreviewed`,
src/merge/merge-post-review-drain.ts). Nothing an operator reads says any of that: `postReviewStatusLabel`
(src/review/post-merge-review-render.ts) labels an entry `failing` only when `failures` is positive, so a
wall-fed entry renders as a plain `waiting` row — `1. improve a1b2c3d4 · 2h ago · add the parser` with no
bracketed suffix at all — on `tumwater reviews` (list and `-f/--follow`), in `--show`, and on the dashboard's
Post-merge reviews card. During the 2026-11-16 quota wall that is exactly the state the backoff was added
for (BUGS-FIXED.md "A post-merge review that ends on a transient provider failure is retried every poll,
with no backoff and no limit", fixed 2026-11-17), and the fixer changed only the drain: `grep -rn
notBeforeMs src/ui src/cli src/doctor` names no post-review consumer (its only hit,
src/ui/gui/gui-client-backlog.ts, is a queued inbox prompt's `delivers in` clause) — the field rides the
`postReviews` payload (src/ui/status-payload.ts spreads every field but `body`) and the normalized entry,
and then nothing reads it. The merge queue already shows its own deferral this way (` · eligible in
<duration>`, `queueEntryLineHtml`, src/ui/gui/gui-client-pending.ts), so the vocabulary exists to copy.

**Approach:** one exported note function in the renderer, rendered as a bracketed suffix by the CLI list
and the card and as a plain line by the detail view. Nothing changes in src/merge/ or src/review/post-merge-review.ts:
the backoff, its escalation and its skip rule stay as INV-BT5/BT6 pin them; this only reads `notBeforeMs`
and `consecutiveTransientFailures` where the other entry facts are already read.

1. src/review/post-merge-review-render.ts: add `export function postReviewBackoffNote(entry: PostReview,
   now: number): string`. It returns `""` unless `typeof entry.notBeforeMs === "number" && entry.notBeforeMs > now`
   — a *live* wait — and otherwise `provider backoff — retrying in <duration>`, the duration from
   `humanUntil(entry.notBeforeMs, now)` (src/text/datetime.ts, the same `humanSeconds`/`secondsUntil`
   bucketing every other countdown in the harness uses; `humanAgo` is already imported there). A deadline
   already passed renders nothing: the drain admits the entry on the next poll, so there is no wait to
   name, and the list line stays byte-identical to today's. Do not fold it into `postReviewStatusLabel` —
   that switch picks one label by precedence and an entry can hold a content-failure `failures` count *and*
   a transient-failure deadline at once (the infrastructure settle spreads `...entry`, keeping `failures`).
2. Same file, `renderPostReviews`: beside the existing `suffix` (the ` · [label]` the status label
   produces), build `backoff` under the same `typeof now === "number"` guard the existing `age` clause uses
   (the list is callable without a clock) — `""` when the note is empty, else `` ` · [${note}]` `` — and
   append it after `suffix` on the entry line, so an entry without a live wait renders exactly as before. The list already takes `now` (its only clock input, `Date.now()` from
   `cmdReviews`, re-read per `-f/--follow` frame), so the countdown ticks with no new plumbing.
3. Same file, `renderPostReviewDetail`: after the `Failed review runs:` / `Last failure:` block and before
   `Fixed in:`, push `Provider backoff: retrying in <duration>` (the same note minus its `provider backoff — `
   lead, from `humanUntil`) when the live-wait condition holds, and a separate line
   `Transient provider failures in a row: <n>` when `typeof entry.consecutiveTransientFailures === "number"`
   and it is positive — the streak is what says the pause has already doubled toward its cap. Keep the
   detail view untruncated, as its doc comment requires.
4. src/ui/gui/gui-client-pending.ts, `postReviewsHtml`: inside the row builder, beside the existing `label`
   clause, build `const backoff = Number.isFinite(e.notBeforeMs) && e.notBeforeMs > now ? " · <span class='mono'>[provider backoff — retrying in " + esc(humanSeconds(secsUntil(e.notBeforeMs, now))) + "]</span>" : ""` and splice it after the status-label span. The browser bundle has no `humanUntil`, so the twin composes
   `humanSeconds(secsUntil(…))` exactly as `queueEntryLineHtml`'s `eligible in` clause does; `humanSeconds`
   and `secsUntil` are already in the `format` region, which the pending-table tests load.
5. src/cli/cli-help-text.ts, the `tumwater reviews` stanza: after the failed-review-run-count clause, say
   that an entry inside a transient-provider-failure backoff also carries `[provider backoff — retrying in
   <duration>]` while that wait holds, and that `--show` names the wait and the consecutive-failure streak.
6. docs/cli.md, the Check state row's `tumwater reviews` clause: same sentence in prose — the list names a
   live provider backoff, `--show` names it whole with the streak. docs/how-it-works.md, the Post-merge
   reviews card sentence ("each with its rejected … or failed-review status"): add that a row also names a
   live provider-failure backoff and its countdown, the browser twin of the list's bracket.
7. docs/invariants.md INV-BT6's **Binds.** gains `src/review/post-merge-review-render.ts`
   (`postReviewBackoffNote`) and `src/ui/gui/gui-client-pending.ts` (`postReviewsHtml`) as readers of
   `PostReview.notBeforeMs`, so the field's meaning keeps one home; its **Guarantee.** and **Pinned by.**
   sentences stay as they are (the drain's selection is unchanged), and INV-BT5 is untouched.

**Files touched:** src/review/post-merge-review-render.ts, src/ui/gui/gui-client-pending.ts,
src/cli/cli-help-text.ts, docs/cli.md, docs/how-it-works.md, docs/invariants.md,
test/post-merge-review-render.test.ts, test/cli-reviews.test.ts, test/gui-client-pending.test.ts.
No change to src/merge/merge-post-review-drain.ts, src/review/post-merge-review.ts, or
src/ui/status-payload.ts — the backoff, its writer and the payload stay as they are, so `--json` keeps its
exact current shape. Independent of the one open BUGS.md entry (in flight by bugfix-2, src/runner,
src/scheduling, src/git, src/run) and of every `## Planned` sibling — `## Planned` holds no other entry and
`grep -n 'post-merge-review-render\|gui-client-pending' PLANS.md BUGS.md` matches nothing outside this entry.

**Acceptance criteria.**
- `postReviewBackoffNote(e({ notBeforeMs: now + 600_000 }), now)` answers exactly
  `provider backoff — retrying in 10m`; `postReviewBackoffNote(e({ notBeforeMs: now - 1 }), now)`,
  `postReviewBackoffNote(e({}), now)` and a bare `notBeforeMs: now` all answer `""`.
- `renderPostReviews([e({ notBeforeMs: <render now> + 600_000 })], undefined, <render now>)` prints the
  entry line ending ` · [provider backoff — retrying in 10m]`; the same entry with `notBeforeMs: <render
  now> - 1` and an entry without the field print lines byte-identical to today's (the existing
  "an entry with neither rejected nor failures carries no suffix" test stays green). An entry carrying both
  `failures: 2`/`lastFailure: "boom"` and a live deadline prints both brackets — the failed-run label and
  the backoff — in that order, proving the note is not part of the status-label switch.
- `renderPostReviewDetail(e({ notBeforeMs: now + 90_000, consecutiveTransientFailures: 3 }), 1, now)`
  contains the lines `Provider backoff: retrying in 2m` and `Transient provider failures in a row: 3`;
  the same entry with `consecutiveTransientFailures: 0` prints the backoff line and no streak line, and an
  entry with no `notBeforeMs` prints neither (the existing "adds each optional block only when its field is
  present" test stays green).
- Spawned `tumwater reviews` in a repo whose `.tumwater/state/post-review.json` holds one entry with
  `notBeforeMs: Date.now() + 600_000` exits 0 and its stdout matches
  `\[provider backoff — retrying in 10m\]`; `tumwater reviews --json` on the same file prints a `pending`
  row whose `notBeforeMs` equals the seeded number and which carries no new key.
- `postReviewsHtml([{ role: "feature", commit: "abcdef1234567890", summary: "x", notBeforeMs: now + 42_000 }],
  "", "", "", now)` contains `[provider backoff — retrying in 42s]` and the same entry without `notBeforeMs`
  contains no `provider backoff` text (explicit `now` argument, as the state-picker test already passes).
- `node scripts/tsc.mjs --incremental`, the four named test files, and check-permit over backlog-structure
  plan-citations backlog-eligibility invariants-doc cli-doc stay green.

## Done
