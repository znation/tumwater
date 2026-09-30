# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

### Backlog moves cut and paste under the existing heading: prompt wording for feature, bugfix, and conflict resolution (planned 2026-09-30) — part 1/4, the prompts

**Goal.** Stop loops from rewriting a backlog file's section headings when they move an entry.
On 2026-09-25 the feature loop's `run --once` commit `52cbadd1` marked its plan done by
rewriting the top of PLANS.md in place (`## Planned` / `### X` became `## Planned` /
`_None yet._` / `## Done` / `### X (…, done …)`) and never touched the existing `## Done`
further down. That left PLANS.md with two `## Done` headings. The next three feature commits
(`761af2b7`, `758e6de1`, `f91ed2b2`) repeated the shortcut, each adding one heading and
removing one, so the count stayed at two. Then the timed-pause plan's landing (`9eaae5ac`)
hit a rebase conflict. The conflict-resolution run stripped the markers and kept both
sides, so the new plan ended up after a Done entry, under the first `## Done`, and the
file had three `## Done` headings. The plan sat outside `## Planned` until the clean loop
re-filed it (`b7ab97c7`, 14:38). The root cause is the wording: the feature prompt says
"move it to a Done section with the date" and bugfix says "move it to a Fixed section".
Both read as "create a section", and nothing says the heading already exists.

**Approach.**
- src/roles.ts, `feature` role `find` text: replace "(move it to a Done section with the
  date)" with wording that says to cut the entry out of `## Planned`, paste it as the first
  entry under the file's existing `## Done` heading with the done date in its heading, and
  never add, remove, or rename a `## ` heading. When the moved entry was the last one under
  Planned, `## Planned` keeps a `_None yet._` placeholder. `grep -n '^## ' PLANS.md` should
  list the same headings before and after the edit.
- src/roles.ts, `bugfix` role `find` text: the same fix for "(move it to a Fixed section with
  the date)", naming `## Open` → the existing `## Fixed`.
- src/gate-prompts.ts `buildConflictPrompt`: add one rule for backlog files. When a
  conflicted file is PLANS.md, BUGS.md, or QUESTIONS.md, resolve section headings as
  structure, not text: the result keeps exactly one of each `## ` heading, and every
  `### ` entry sits under the section its own side put it in (a new plan stays under
  `## Planned` even when main's side moved entries around it). Keep this generic, e.g. "for
  markdown backlog files, the `## ` section headings are structure: never duplicate one" —
  the prompt must not grow file-specific branches for every name.
- Keep wording shared, not repeated: if the two role strings end up with the same
  sentence, extract a helper in src/role-guidance.ts (the home of `PLAN_SIZING` and the
  other shared role clauses) that takes the section names.

**Files touched.** src/roles.ts, src/gate-prompts.ts, possibly src/role-guidance.ts;
test/prompt.test.ts and test/gate-prompts.test.ts.

**Acceptance criteria.**
- The feature and bugfix prompts name the existing `## Done` / `## Fixed` heading and forbid
  adding a second one; neither says "a Done section" or "a Fixed section" anymore.
- `buildConflictPrompt` carries the backlog-heading rule; test/gate-prompts.test.ts pins it
  beside the existing "combining the intent of BOTH sides" assertion.
- test/prompt.test.ts pins the new feature and bugfix wording.
- `npm run test` passes.
- Part 2/4 (the deterministic check below) is the backstop; this part only makes the
  failure rarer, so it lands first and on its own.

### Backlog structure check at the review gate and the in-lock landing re-check (planned 2026-09-30) — part 2/4, the backstop

**Goal.** A change that leaves PLANS.md, BUGS.md, or QUESTIONS.md with a duplicated or
dropped `## ` section heading must not reach main. Today nothing checks backlog structure.
The Planned reader in src/backlog.ts (`parseEntryDetails`) stops at the first `## `
heading, so extra Done headings parse cleanly, and the damage stays invisible until an entry
ends up on the wrong side of one. Markdown-only diffs skip both the build check and the model
reviewer (`isExemptDiff` over `config.review.exemptPaths`, default `*.md`), so the plan and
clean loops' landings get no structural check at all. On 2026-09-25 the malformed files
came from two paths: a feature commit's own edit (`52cbadd1`), and an md-only plan landing
whose conflict resolution added a third `## Done` (`9eaae5ac`). A check at the review gate
alone would have caught the first but not the second, because the conflict resolution
happens after the gate, inside the landing.

**Approach.** Follow the `falseFixReason` precedent (src/fix-claim.ts): a deterministic,
no-pi check that returns a rejection reason or nothing, called from the same two places.
- New module src/backlog-structure.ts exporting `backlogStructureReason(wt, mainBranch,
  files)`. It runs only when `files` includes PLANS.md, BUGS.md, or QUESTIONS.md. For each
  touched file it reads the `## ` headings (fence-aware, reusing backlog.ts's fence scanner
  (`fenceTracker` / `parseEntryDetails`) so a `## Done` quoted inside a code block is not a
  heading) on the tree being landed and on the diff's merge-base (the same base
  `falseFixReason` compares against). It returns a reason naming the file and the heading
  when:
  (a) any `## ` title appears more than once, or
  (b) a `## ` title present on the base is missing on the head.
  Do NOT hard-code the section names: the rule is "same heading set as the base, no
  duplicates", so a project whose BUGS.md adds `## Verified` (this repo's does) or a fresh
  repo seeded from src/init.ts's templates both pass unchanged. A base that already has a
  duplicate must not block unrelated edits forever: rule (a) fires only when the head's
  count for that title is greater than the base's (a change that removes a duplicate always
  passes).
- src/review.ts, the gate: call it on BOTH paths, for exempt (md-only) diffs next to
  `falseFixReason`, and for non-exempt diffs as a deterministic rejection before the build
  pre-check (no pi run spent), through the same `reject([...])` helper so the author's next
  tick sees the reason.
- src/landing-merge.ts `verifyLanding`: call it after the rebase on both branches (exempt
  and full check), before `runScopedBuildCheck`. A structural failure returns false
  (→ `merge_blocked`), like a false fix. Log a `warning` event naming the file and heading,
  so a conflict resolution that broke structure shows on the dashboards instead of reading
  as an unexplained block. Keep the existing early return for an unchanged rebase: that
  tree already passed the gate's check.
- Optional, same change if small: add a `tumwater doctor` line reporting a duplicated
  heading already present on main (src/doctor-checks.ts already has a fix-claims check to
  copy the shape from), so an existing malformed file is visible without waiting for the
  next edit to trip the gate.

**Files touched.** src/backlog-structure.ts (new), src/review.ts, src/landing-merge.ts,
optionally src/doctor-checks.ts; test/backlog-structure.test.ts (new), plus one gate test
and one landing test beside the existing false-fix ones.

**Acceptance criteria.**
- Unit: a PLANS.md head with two `## Done` headings where the base had one yields a reason
  naming `PLANS.md` and `## Done`; a head that drops `## Planned` yields one; a `## Done`
  inside a fenced block is ignored; a head whose base already had two `## Done` and still
  has two passes; a head that removes a duplicate passes; BUGS.md with `## Open` /
  `## Fixed` / `## Verified` unchanged passes.
- Gate: an md-only diff that duplicates `## Done` is rejected with that reason and spends
  no pi run; a code diff that does the same is rejected before the build pre-check runs.
- Landing: reproduce the 2026-09-25 shape in a fixture repo. The branch adds a plan under
  `## Planned`; main moves the only planned entry to Done by adding a `## Done` above it;
  the rebase conflicts and a fake conflict resolver keeps both sides. `verifyLanding`
  refuses (merge_blocked) and logs the warning; main is unchanged.
- `npm run test` passes; the existing false-fix gate and landing tests are unchanged.

### Stranded-plan detection: the clean loop re-files an open plan sitting under `## Done` (planned 2026-09-30) — part 3/4, the repair

**Goal.** Parts 1/4 and 2/4 stop a duplicated `## Done` heading from landing, but a plan can
be stranded without one. A conflict resolution or a misplaced insert can put a new
`### … (planned YYYY-MM-DD)` entry just below the file's single `## Done` heading, and the
set of `## ` headings is unchanged, so part 2's check passes it. The Planned reader
(`plannedPlanEntries`, src/backlog.ts) then never lists it: the dashboards, `tumwater
backlog`, and the plan loop's "two or more plans wait" rule all miss it. The feature loop only
finds it if it reads past `## Done`. On 2026-09-25 the timed-pause plan sat like this from
13:10 to 14:38. The clean loop repaired it (`b7ab97c7`), but only because it happened to
look, since its prompt is about code. The reverse case is the same kind of error: an entry
still under `## Planned` whose heading already carries a `done YYYY-MM-DD` was finished and
never moved, so the feature loop may implement it again. Make detection deterministic and
hand the repair to clean.

**Approach.**
- A pure detector, `strandedPlanEntries(md)`, in src/backlog-structure.ts (created by part
  2/2; if this part lands first, create the module here and part 2 adds to it). It is
  fence-aware through backlog.ts's `parseEntryDetails`, like every other backlog reader. It
  returns the `### ` headings of:
  (a) entries under `## Done` whose heading has a `(planned YYYY-MM-DD…)` parenthetical but
  no `done YYYY-MM-DD`;
  (b) entries under `## Planned` whose heading already carries `done YYYY-MM-DD`.
  Scope is PLANS.md only. This repo's PLANS.md satisfies both rules today; every retained
  Done heading carries a done date. BUGS.md does not: two retained Fixed-section headings
  lack a `fixed YYYY-MM-DD` suffix, so a BUGS.md version would misfire and is out of scope.
- src/tick-prompt.ts: for `role === "clean"`, read the primary checkout's PLANS.md (the
  same `root` the telemetry digest and qa coverage blocks read) and, when the detector
  returns anything, render a `<backlog-structure>` block listing each stranded heading with
  its current section. Pass it through a new optional `TickPromptInput` field in src/prompt.ts,
  following the `digest`/`coverage` precedent. An unreadable or clean file gives no block, so
  the prompt is unchanged in the common case.
- src/roles.ts, `clean` role `find` text: one sentence. When a `<backlog-structure>` block is
  present, that repair is this tick's ONE task: move each listed entry to the section its
  heading says it belongs in (cut and paste, under the existing heading, never adding a `## `
  heading), and change nothing else.
- `tumwater doctor` (src/doctor-checks.ts): a warn line naming each stranded heading on main,
  beside part 2/4's optional duplicate-heading line if that has landed, so an operator sees
  the state without waiting for a clean tick.
- Read each heading with its wrapped continuation lines joined. Many headings wrap their
  parenthetical onto a second line (`(planned 2026-09-02, done` / `2026-09-03)`), and
  `parseEntryDetails` titles keep only the first line, so matching titles alone reports those
  as missing a done date. `entryDates` in the same file already joins heading metadata up to
  the closing `)`; extract that join into a shared helper rather than writing a second one.
- Rejecting a stranding change at the gate is part 4/4, not this part.

**Files touched.** src/backlog-structure.ts (new or extended), src/tick-prompt.ts,
src/prompt.ts, src/roles.ts, src/doctor-checks.ts; test/backlog-structure.test.ts,
test/prompt.test.ts, one doctor test.

**Acceptance criteria.**
- Unit: a PLANS.md fixture that reproduces the 2026-09-25 shape (a `(planned 2026-09-25)`
  entry directly under the only `## Done`) yields that heading; a `(planned …, done …)` entry
  under Done yields nothing, and neither does one whose done date sits on a wrapped second
  heading line; an entry under Planned with a done date yields it; a stranded-looking
  heading inside a fenced block is ignored; this repo's current PLANS.md yields nothing.
- The clean tick's prompt carries the `<backlog-structure>` block when the fixture root is
  stranded and omits it otherwise; the clean `find` text names the block.
- `tumwater doctor` warns on the stranded fixture and is silent on a clean one.
- `npm run test` passes.

### Reject a change that files a new plan directly under `## Done` (planned 2026-09-30) — part 4/4, the gate rule

**Goal.** Part 3/4 repairs a stranded plan after it lands; this part stops the most common
stranding from landing at all. The case is a change that ADDS a new PLANS.md entry and puts it
under `## Done` with no done date: a plan written into the wrong section, or a conflict
resolution that keeps both sides and puts the new plan on the Done side of a heading
(2026-09-25, `9eaae5ac`). Part 2/4's heading check cannot see this when the file has a single
`## Done`, because the heading set is unchanged.

**Evidence the rule is safe to enforce now (measured 2026-09-30).** Replaying the rule below
over all 390 versions of PLANS.md on main's first-parent history (`git log --first-parent
main -- PLANS.md`) fires on exactly one commit: `9eaae5ac`, the real stranding. A naive rule
("any `(planned …)` entry under Done without a done date") fires on 22 commits, 21 of them
false. Those false hits have two shapes, and the rule has to avoid both:
- **Wrapped headings.** The done date sits on the heading's second line (`(planned
  2026-09-02, done` / `2026-09-03)`). Join heading continuation lines first, with part 3/4's
  shared helper.
- **Legitimate moves under the older convention.** Through mid-September, entries were moved
  Planned → Done without adding a done date to the heading (e.g. `Pre-flight environment
  check — tumwater doctor (planned 2026-09-05)` at `cd31355e`). A move is not a stranding:
  the entry already existed on the base.

**Approach.**
- In src/backlog-structure.ts (from 2/4 and 3/4), add the rule to the gate-side check that
  part 2/4's `backlogStructureReason` runs, so both call sites get it with no new wiring.
  Those call sites are the review gate in src/review.ts (md-only and code diffs alike, as a
  deterministic `reject`) and `verifyLanding` in src/landing-merge.ts after the rebase
  (→ `merge_blocked` plus a `warning` event). The second one is the site that catches a
  conflict resolution. The rule applies to PLANS.md only. Reject when the head has a
  `### ` entry under `## Done` that meets all three conditions:
  (1) its joined heading metadata has a `(planned YYYY-MM-DD` parenthetical;
  (2) it has no `done YYYY-MM-DD`;
  (3) its key does not appear as a `### ` heading ANYWHERE in the base's PLANS.md (any
  section). The key is the heading text before its first ` (`, whitespace-normalized; this
  matches how `normalizeFixedHeading` in src/fix-claim.ts compares headings across a move.
  The reason names the entry and says to file it under `## Planned`, so the author's next
  tick (or a retry of the leftover) knows the one-line fix.
- The base is the diff's merge-base, the same one part 2/4 and `falseFixReason` use. A
  stacked batch where one change adds a plan and a later change stamps it done is then
  measured change by change, not against main's tip.
- Deliberately not gated: part 3/4's reverse case (a done-dated entry still under
  `## Planned`) and any pre-existing stranded entry. Both stay part 3/4's repair job, so an
  old mistake never blocks unrelated landings.

**Files touched.** src/backlog-structure.ts; test/backlog-structure.test.ts, plus one gate
test and one landing test next to part 2/4's.

**Acceptance criteria.**
- Unit: rejects a head that adds `### X (planned 2026-09-25)` directly under the only
  `## Done`. Passes all of these:
  - the same entry under `## Planned`;
  - a Planned → Done move whose heading keeps only its `(planned …)` date (the `cd31355e`
    shape);
  - a new entry under Done whose done date is on a wrapped second heading line;
  - a new entry filed directly as done (`(planned …, done …)`), as hand commits recording
    finished work do;
  - a heading inside a fenced block.
- Gate: an md-only plan-loop diff shaped like `9eaae5ac` is rejected with the reason and
  spends no pi run.
- Landing: in part 2/4's conflict fixture with ONE `## Done` heading on main, a fake resolver
  that places the branch's new plan below that heading makes `verifyLanding` refuse
  (merge_blocked) and log the warning; main is unchanged.
- The implementing tick re-runs the history replay once and records the hit count in its
  commit body's VERIFIED line. The expected hit is only `9eaae5ac`; a second hit means
  the rule is wrong, not that history has another stranding to excuse. This is a one-off
  check, not a suite test: it reads this repo's history, not a fixture.
- `npm run test` passes.

### Image drag-and-drop into the GUI composer: dropped or pasted images are saved beside the queued prompt and the prompt text points the loop at them (planned 2026-09-30)

**Goal.** Dropping image files onto the "Tell the fleet what to do next…" textarea in the GUI (and pasting an image from the clipboard) attaches them to the queued prompt: each image is stored on disk and the prompt text gains one `[image attached: <absolute path>]` line per image, so the receiving loop's pi agent can view the file with its read tool (pi renders images). Works for both the director target and a per-role target. The CLI `tumwater prompt` stays text-only — out of scope.

**Approach.**

1. New module `src/inbox-attachments.ts`:
   - `PROMPT_IMAGE_EXTENSIONS: readonly string[]` = png, jpg, jpeg, gif, webp, bmp (exactly what pi's read tool renders); `PROMPT_IMAGE_MAX_BYTES = 5 * 1024 * 1024` per image; `PROMPT_IMAGES_MAX_COUNT = 4` per prompt.
   - `savePromptImages(root, role, images): { paths: string[] } | { problem: string }` — validates `images` (an array of `{ name, dataBase64 }`, at most `PROMPT_IMAGES_MAX_COUNT`, each name's extension in `PROMPT_IMAGE_EXTENSIONS`, each decoded size within `PROMPT_IMAGE_MAX_BYTES`), sanitizes each name to `[A-Za-z0-9._-]` (default `image.png`, basename only), and writes each file into `roleInboxDir(root, role)` with the **same stem as the queue file it will belong to**: the caller enqueues the prompt's `.md` with `queueFileName(...)` first, then images are written as `<stamp>-<seq>-<pid>.<ext>` beside it (image extensions never collide with the `.md` filter in `listQueueFiles`). Returns the absolute paths in order.
   - `imageReferenceLines(paths: string[]): string` — the text to append: `"\n\n"` then one `"[image attached: <absolute path>]"` line per path.
2. `src/ui/gui-endpoints.ts` — extend `handlePrompt` and `handlePromptRole` with an optional `images` body field: after `requirePromptText`, call `savePromptImages`; a `problem` answers 400 with that reason and writes nothing; success enqueues `text + imageReferenceLines(paths)` through the existing `submitPrompt` / `submitRolePromptAndWake`. The existing length rule (`promptLengthProblem`) applies to the final text including the reference lines — fine, they are short. `promptPreview` naturally shows the first reference line if the prompt is short; no change needed there.
3. Attachment cleanup: in `src/inbox.ts`'s `takeQueuedFile`, after removing the queue `.md`, also remove same-stem siblings in the same directory (any file whose name equals the `.md`'s stem plus an extension) — ENOENT-tolerant like `removeQueueFile`. This covers both dequeue (the loop's tick picks the prompt up) and cancel (`cancelQueuedFile`, `cancelRolePrompt`), so images never outlive their prompt.
4. `src/ui/http-body.ts` — raise `MAX_BODY_BYTES` from 64 KiB to `32 * 1024 * 1024` (32 MiB): 4 images × 5 MiB × ⁴⁄₃ base64 ≈ 27 MiB must fit one POST. The cap exists to bound memory on a local dashboard; update its comment to say so, and update any test pinning the old cap or the "body too large" message (grep test/ for `body too large`).
5. Client `src/ui/gui-client-fleet.ts`:
   - A single pending-image list shared across targets (not per-target like `drafts`), cleared only on a successful submit or manual removal.
   - `dragover` (preventDefault + a highlight class) / `drop` on `#prompt`, and a `paste` listener that collects `clipboardData.files` items whose type is an image; ignore anything that is not an image.
   - Render one chip per pending image (name, size, a remove ×) into a new `<div id="promptimages">` container inside `#promptform` in `src/ui/gui-page.ts`; an empty container stays hidden.
   - In the `promptform` submit handler: read each pending `File` as a data URL (`FileReader.readAsDataURL`, strip the `data:...;base64,` prefix), include them as `images: [{ name, dataBase64 }]` in the `sendPrompt` body (both `/api/prompt` and `/api/prompt-role`), clear the list only on success — a rejected submit keeps text and images so it can be fixed and resent, matching today's text behavior. Flash message names the attachment count when images rode along.

**Files touched:** `src/inbox-attachments.ts` (new, ~90 lines), `src/inbox.ts`, `src/ui/gui-endpoints.ts`, `src/ui/http-body.ts`, `src/ui/gui-client-fleet.ts`, `src/ui/gui-page.ts`, tests (`test/inbox-attachments.test.ts` new; `test/cli-gui.test.ts` endpoint e2e; the http-body 413 test).

**Acceptance criteria.**

1. A POST to `/api/prompt` (or `/api/prompt-role`) with `images` writes each image beside the queue `.md` under the same stem, and the queued prompt's text ends with one `[image attached: <absolute path>]` line per image pointing at a file that exists on disk.
2. A non-image extension, more than `PROMPT_IMAGES_MAX_COUNT` images, a `dataBase64` that does not decode, or a decoded image over `PROMPT_IMAGE_MAX_BYTES` answers 400 naming the rule, with no queue file and no image written.
3. Dequeuing the prompt (unit-level: `dequeueRolePrompt`) and cancelling it (`cancelQueuedFile`) remove the `.md` **and** its same-stem image files; a vanished sibling is tolerated.
4. The 32 MiB body cap holds: an oversized body still answers 413 with the updated message; the existing per-endpoint 400/413 discipline is unchanged for text-only submits.
5. Client behavior (drop, paste, chips, clear-on-success, keep-on-failure) is implemented in the served client script and covered by the endpoint e2e for its server half; `npm run test` passes.

Sizing: one run — ~90 new lines in the new module, ~40 across the two endpoints/inbox, ~80 client, ~180 tests. No sub-plans needed.

### Land queue drawer: clicking the GUI sidebar's "Land queue" chip lists the queued changes (planned 2026-09-30)

**Goal.** The GUI sidebar shows `Land queue N` (a row in the `statuschips` panel, `renderSidebar` in `src/ui/gui-client-fleet.ts`) whose only detail is a hover title naming the count and — sometimes — the one landing currently in flight. An operator cannot see WHAT is queued: which roles are waiting, what each change is, or how long each has sat in the queue. Clicking the chip opens the dashboard's detail drawer (the same sheet loops and backlog entries use) listing every queued change — position, role, summary, short sha, age — plus the in-flight landing when one is running.

**Approach.**

1. Server payload — `src/status-data.ts`: the snapshot already reads every queued entry each poll (`queuedLandings(root)` into `landings`, used only for `.length` and the in-flight cross-check) and `LandingEntry` already carries `role`, `sha`, `tick`, `summary`, `enqueuedAt`. Extend `StatusSnapshot.landQueue` with `entries: Array<{ role: string; sha: string; tick: number; summary: string; enqueuedAt: number }>` — filled from `landings` (shallow per-entry copies without the optional `body`/`highFriction`) only when `depth > 0`, absent when empty, exactly the `roleInboxPrompts` filling discipline (documented in the same doc comment). Zero extra reads per poll: the entries come from the listing pass the depth already pays for, and `landing-queue.ts`'s stat cache keeps unchanged files at one stat. `src/ui/status-payload.ts` passes `landQueue` through untouched — no change there.
2. Client drawer — `src/ui/gui-client-drawer.ts`: add a third drawer kind, `drawer = { kind: "landqueue" }` (the union comment on the `drawer` variable names the current two). New `openLandQueue()` / `toggleLandQueue()` mirroring `openEntry`/`toggleEntry` (no hash — like the entry drawer, the drawer is transient state, not a shareable view), a `renderLandQueueDrawer(d)` that paints `drawerhead` (kicker "Land queue", title `N changes`, a `Landing now: <role> — <summary> (<stage>)` pill from `landQueue.inFlight` when present) and `drawerbody` (one section per queued entry in payload order: position, `role` in mono, `summary`, `<sha.slice(0, 8)>` in mono, `fmtAgo(enqueuedAt)`; the existing `sec-head`/`note` markup the loop drawer uses) — and a `"landqueue"` case in `refreshDrawer()` so the open drawer repaints on each 1 s poll instead of going stale. Esc, the close button, and re-click all close it through the existing `closeDrawer`.
3. Click wiring — `src/ui/gui-client-fleet.ts`: the `Land queue N` row gets `data-action='landqueue'` (and `cursor:pointer` styling); the sidebar panel `#statuschips` gains a delegated click listener (the same pattern the backlog panel's `$("backlog").addEventListener("click", …)` already uses) that calls `toggleLandQueue()` when the click lands on that row. The row keeps its existing `landingTitle` tooltip.
4. Tests: `test/status.test.ts` (or its `test/status-fixtures.ts` helpers) asserts the new `landQueue.entries` shape — present with the queued roles/shas/summaries in queue order when entries are enqueued (use `enqueueLanding`), absent when the queue is empty, and absent-but-depth-N after entries drop. `test/cli-gui.test.ts` gets one e2e: enqueue a landing, GET the served page, and assert the `/api/status` payload's `entries` reach the client (the drawer rendering itself is client-side script — the endpoint e2e covers its server half, as the drag-and-drop plan's client behavior does).

**Files touched:** `src/status-data.ts` (~15 lines: type + fill + doc comment), `src/ui/gui-client-drawer.ts` (~70 lines), `src/ui/gui-client-fleet.ts` (~10 lines), `src/ui/gui-styles.ts` (pointer cursor for the clickable row, a line or two), tests (`test/status.test.ts`, `test/cli-gui.test.ts`, ~120 lines).

**Acceptance criteria.**

1. With entries enqueued, `/api/status`'s `landQueue.entries` lists each in queue order (oldest first) with `role`, `sha`, `summary`, `enqueuedAt`, and `tick`; with an empty queue the field is absent and `depth` is 0. The in-flight `inFlight` block is unchanged.
2. Clicking the sidebar's `Land queue N` chip opens the drawer listing every queued change (position, role, summary, short sha, age) and, while a landing runs, the in-flight change with its stage; the drawer refreshes on subsequent polls while open; Esc / close / re-click closes it; clicking any other sidebar row does not open it.
3. No extra per-poll reads are introduced beyond what the depth already costs (the entries ride the existing `queuedLandings` pass).
4. `npm run test` passes, including the new snapshot-shape and GUI e2e assertions.

Sizing: one run — ~95 lines across three client/server files plus styles, ~120 test lines. No sub-plans needed.

## Done

### GitHub CI on main builds the installable npm package and uploads it as a workflow artifact (planned 2026-09-30, done 2026-09-30)

**Goal.** Every push to `main` on GitHub produces a downloadable, installable package — the packed
npm tarball — attached to that CI run as a workflow artifact, so a user can grab the current state
of main without a tag release or npm publish.

**Approach.** Extend `.github/workflows/ci.yml` (currently a single `test` job) with a second job,
`package`, that runs only on pushes to main (`if: github.event_name == 'push' && github.ref ==
'refs/heads/main'`) and never on pull requests:

1. `actions/checkout@v4` + `actions/setup-node@v4` with `node-version: 22` and `cache: npm`, matching
   `release.yml`'s pins (the release workflow is the house style for packaging steps).
2. `npm ci`.
3. `npm pack` — `prepack` already runs `npm run build` (`rm -rf dist && tsc && node
   scripts/stamp-build.mjs`), so the tarball always carries a freshly stamped `dist/`. Do NOT run the
   test suite in this job: the existing `test` job already gates the run, and duplicating it doubles
   CI minutes for no new signal.
4. Upload with `actions/upload-artifact@v4`: `name: tumwater-${{ github.sha }}` (the sha disambiguates
   artifacts across runs, which would otherwise collide on one name), `path: tumwater-*.tgz`,
   `retention-days: 30` (a main build is a moving target; release tarballs keep living on the releases
   page via `release.yml`).

Notes for the implementer:
- The job needs no git identity config (the suite's fixture commits only matter when tests run; the
  `test` job already sets one).
- Keep both jobs independent (no `needs:`) so a packaging failure cannot block the test report and
  vice versa; GitHub marks the run red either way.
- No new dependencies, no package.json changes — `files`/`bin` are already declared there and
  `prepack` is already wired.

**Files touched.** `.github/workflows/ci.yml` only.

**Acceptance criteria.**
- A push to main produces a workflow run containing a `package` job whose artifact is the packed
  tarball (one `.tgz`, name `tumwater-<version>-<sha>`), downloadable from the run page.
- Pull-request runs and pushes to non-main branches run only the `test` job — no artifact upload.
- The workflow YAML is valid (`node -e "…yaml check…"` is not available offline; verify by eyeballing
  structure against `release.yml` and running `npm pack` locally to confirm `prepack` produces
  `tumwater-<version>.tgz`).
- `npm run test` stays green (nothing in the suite can see this change, but the tick's gate still
  applies).

Implemented 2026-09-30 by the feature loop: added the `package` job to `.github/workflows/ci.yml` per the approach (push-to-main only, `node-version: 22` and `cache: npm` matching `release.yml`, `npm ci`, `npm pack`, `upload-artifact@v4` named `tumwater-${{ github.sha }}` with `retention-days: 30`); both jobs stay independent. Verified locally: `npm pack` produces `tumwater-0.1.0.tgz` through the `prepack` build, and `npm run test` is green (2427 tests).

### Quiet hours: surface the window on the dashboards (planned 2026-09-30, done 2026-09-30) — part 2/2, observability

**Goal.** Part 1/2's gate is invisible: an operator looking at `tumwater status`, the TUI, or the GUI during a quiet window sees idle loops but no reason. Surface the configured window and whether the fleet is inside it, the same way the pause and budget gates are surfaced.

**Approach (as landed).**
- src/status-data.ts: `StatusSnapshot` carries `quietHours` (the operator's own window string, trimmed, absent when unset or off) and `inQuietHours`, computed fresh per poll through a new `quietHoursStatus` helper in src/quiet-hours.ts — the same membership predicate the gate polls, so the dashboards and the hold cannot disagree. A malformed config value degrades with the whole config (configForStatus's last-known-good hold), so the badge never flashes off on one broken write.
- Renderers: a `quietBadge` in src/ui/badges.ts (beside `pauseBadge`, the header badges' one home) renders `· quiet until 07:00` while inside the window and `· quiet 23:00-07:00` otherwise; renderStatus appends it to the header after the pause badge. The active in-window indicator is a blue `quiet` alert in src/ui/fleet-alerts.ts — informational, no actions — which both the TUI's attention lines and the GUI's alerts band render through the shared `fleetAlerts`, the `paused` field's actual render precedent. The GUI's sidebar (gui-client-fleet.ts) adds a quiet chip from the payload's raw fields, and status-payload.ts ships `quietHours`/`inQuietHours` plus the preformatted `quietBadge`.
- src/help.ts: the `config` stanza now names `quietHours` among the settable keys.

**Files touched.** `src/quiet-hours.ts`, `src/status-data.ts`, `src/ui/badges.ts`, `src/ui/status-render.ts`, `src/ui/fleet-alerts.ts`, `src/ui/status-payload.ts`, `src/ui/gui-client-model.ts` (alert icon), `src/ui/gui-client-fleet.ts` (sidebar chip), `src/help.ts`, README's settings line; tests in `test/quiet-hours.test.ts`, `test/status-header.test.ts`, `test/fleet-alerts.test.ts`, `test/status.test.ts`, plus the `snapshotWith` fixture.

**Deviations from the entry as written.** The plan named `src/ui/tui-frame.ts` for the TUI, but the TUI owns no badge code of its own — it paints the shared header (status-render.ts) and alerts (fleet-alerts.ts), which now carry the field; the anchor was stale. The window/in-window derivation factored into `quietHoursStatus` in quiet-hours.ts rather than inline in status-data.ts, keeping the domain logic in one module. `help.ts` had no settable-key list to extend, so the `config` stanza gained one.

**Acceptance criteria.**
- `tumwater status` shows the configured window and, inside it, an active quiet-hours indicator naming the window end; with `quietHours` unset, output is byte-identical to today's (pinned: the header badge is empty without a window, and the fleet-alerts suite asserts no quiet alert outside the window).
- The TUI and GUI render the same field without layout regressions in the existing test fixtures (full suite green).
- Depends on part 1/2 (`quietHours.ts`'s `parseQuietHours`/`inQuietHours` and the config key) — landed 2026-09-30 (see Done); this part lands once that is the running build.

**Done 2026-09-30 by feature.**

### Quiet hours: a daily local-time window the fleet holds itself during (planned 2026-09-30, done 2026-09-30) — part 1/2, the gate

**Goal.** A fleet that runs 24/7 spends budget overnight on work nobody is awake to steer. Add a
config-driven daily window during which role loops start no new ticks, so an operator can set
`quietHours` once (e.g. `"23:00-07:00"`) and the fleet idles through it every night — the
operator pause's semantics on a schedule, without anyone typing `tumwater pause` at 23:00.

**Approach.**
- New `src/quiet-hours.ts`: `parseQuietHours(value: unknown)` returns `{ ok: true, window } | { ok: false, error }` (window null when off; minutes since local midnight otherwise) or an actionable error message; `inQuietHours(window, date)` decides membership for a `Date` in LOCAL time (a window that wraps midnight, `start > end`, spans across 00:00; `start === end` is a parse error, not a zero-length always-on window; same-day windows are half-open `[start, end)`); `pollQuietHoursGate(root, quietHours, state, now)` mirrors `pollPauseGates`'s edge-triggered shape — it logs exactly one `quiet_hours_started` / `quiet_hours_ended` event (`loop: "harness"`, carrying the window string) per crossing, holding the previous in-window boolean in `QuietHoursGateState` (in memory only; a restart mid-window logs one event on the first poll, like the pause gate). The config value is read fresh per poll, so a live edit applies on the next cycle.
- Config: the optional `quietHours?: string` key added to `TumwaterConfig` (src/config-schema.ts) and to `TOP_LEVEL_KEYS` (src/config-validation.ts); `validateConfig` rejects a non-string or a malformed value using `parseQuietHours`'s message (empty string means off). `checkQuietHours(value)` added to src/config-write.ts beside `checkDailyBudgetUsd`, wired into a new per-key validators map in `setConfigKey` so `tumwater config set quietHours "23:00-07:00"` (and the TUI/GUI editors that go through it) share one definition of valid.
- Orchestrator wiring: in src/orchestrator.ts's poll cycle the gate is polled next to `pollPauseGates` and its boolean folded into the same hold site that combines `userPaused || (gate === "paused" && !probeDue)` before `role !== DIRECTOR_ROLE` — the director is exempt exactly as under the budget gate and the operator pause (a human steering outranks a schedule); unlike the budget gate there is no probeDue exception, since a schedule is not probe-worthy. In-flight ticks finish; the gate sits before eligibility, so a tick due inside the window simply starts at window end. No change to the landing pipeline, the budget gate, or scheduling clocks.

**Files touched.** `src/quiet-hours.ts` (new), `src/config-schema.ts`, `src/config-validation.ts`, `src/config-write.ts`, `src/orchestrator.ts`, `src/events.ts` (the two event types), `test/quiet-hours.test.ts` (new), plus additions to `test/config-validation.test.ts` / `test/config-write.test.ts`.

**Acceptance criteria.**
- With `quietHours: "23:00-07:00"` in tumwater.json and the wall clock inside the window, idle role loops start no new ticks while the director keeps ticking; in-flight ticks run to completion.
- Exactly one `quiet_hours_started` event at window entry and one `quiet_hours_ended` at exit per crossing, even across many polls; a restart inside the window logs at most one event.
- A wrapping window (`23:00-07:00`) holds from 23:00 through 00:00 into 07:00; `start === end` and malformed strings fail `validateConfig` and `config set` with an actionable message; absent or empty `quietHours` changes no behavior.
- `npm run test` passes with the new `test/quiet-hours.test.ts` covering parse (valid/wrap/invalid), membership at the boundaries, and edge events.

**Done 2026-09-30 by feature.** One deviation from the plan as written: the director-exemption
criterion is covered at the orchestrator e2e tier (test/orchestrator-quiet-hours.e2e.test.ts —
roles blocked through the startup tick, the director ticking, exactly one event per crossing, a
live `config set quietHours ""` lifting the hold) rather than in the unit file, because the
exemption lives in the poll loop's hold predicate, which only a live orchestrator exercises; the
gating suite runs the unit file, the e2e tier runs the live slice. Part 2/2 (dashboards) remains
in Planned.

### `tumwater config get <key>` / `tumwater config set <key> <value>` — read and edit top-level settings from the terminal (planned 2026-09-30, done 2026-09-30)

**Goal.** Today the only ways to change a setting are hand-editing tumwater.json or the two
narrow in-harness editors (TUI Ctrl+B, GUI /api/budget — both just the budget cap, via
`setDailyBudgetUsd`). `tumwater config` is read-only (show the whole resolved config). Give the
operator a terminal way to read one value and write one top-level key, with the same
fresh-load → validate → atomic-write discipline the in-harness writers already use, so a typo
can never leave a broken or silently-ignored tumwater.json behind. The running fleet needs no
change: the live reload (`newLiveConfigReload` in src/config-live.ts) polls the file every ~2 s
and already picks up external edits.

**Approach.**
- src/config-validation.ts: export `TOP_LEVEL_KEYS` (currently a module-private constant used
  by the top-level `checkKnownKeys` call) so the CLI can name valid keys in its errors instead
  of hardcoding a second list.
- src/config-write.ts: extract the load/validate/write idiom `setDailyBudgetUsd` embodies into
  a small internal helper — fresh `loadConfig(root)` (stat cache bypassed on purpose), apply a
  mutation, `validateConfig`, `writeJsonAtomic(file, cfg, true)` — leaving the file untouched
  (and no tmp remnant) on any failure. Re-point `setDailyBudgetUsd` at the helper and add
  `setConfigKey(root, key, rawValue): { ok: true; oldValue: unknown } | { ok: false; error }`:
  the key must be a member of `TOP_LEVEL_KEYS` (else an error naming the valid keys — the same
  protection `checkKnownKeys` gives the file itself, so `config set modle x` cannot write a
  dead key); the value is `JSON.parse(rawValue)` when that parses, else the literal string (so
  `set maxDailyCostUsd 20` is the number 20 and `set model gpt-5` is the string "gpt-5"); then
  validate the whole merged config so a type mismatch (`set maxDailyCostUsd "20"`) fails with
  validateConfig's own message. Top-level keys only — nested sections (`roles`, `review`,
  `check`, `idleBackoff`, `fallbackModel`) stay file-edited; one op per run.
- src/operator-commands.ts: `cmdConfig(root, args)` dispatches — no args keeps today's
  whole-config JSON dump; `get <key>` prints `JSON.stringify(value)` of that key from the same
  resolved config (defaults merged in, exactly what the no-arg dump prints); `set <key> <value>`
  writes and prints one confirmation line naming the key and its new value; anything else fails
  with usage. Errors go through the standard `fail()`.
- src/cli.ts: the `config` case's `rejectUnknownArgs("config", args, [])` becomes subcommand
  arity checks (`get` takes exactly one arg, `set` exactly two); `requireReadyRepo` stays.
- src/help.ts: update the config line to the three forms.
- Tests: update test/cli-operators-fleet.test.ts's `config takes no flags…` test (now
  `config get`/`set` subcommand arg-shape cases + the help-table match) and add: a get/set
  roundtrip (`set minTickIntervalSeconds 45` then `get minTickIntervalSeconds` prints 45 and
  `loadConfig` sees it), an unknown-key set rejected with the valid-keys list and the file
  byte-identical afterward, a type-invalid set rejected with validateConfig's message and the
  file untouched, and `set model gpt-5` landing as the string. Unit cases for `setConfigKey`
  (JSON-vs-string parsing, untouched file on failure) in test/config-write.test.ts.

**Files touched:** src/config-validation.ts, src/config-write.ts, src/operator-commands.ts,
src/cli.ts, src/help.ts, test/cli-operators-fleet.test.ts, test/config-write.test.ts.

**Acceptance criteria.**
- `tumwater config get <key>` prints the resolved value as JSON; an unknown key exits 1 naming
  the valid keys.
- `tumwater config set <key> <value>` writes the parsed value to tumwater.json atomically,
  prints a confirmation, and a running fleet picks the change up on its next ~2 s config poll
  (no harness code changes needed).
- An unknown key or a value that fails `validateConfig` exits 1 with an actionable message and
  leaves tumwater.json byte-identical (no tmp remnant).
- Bare `tumwater config` behaves exactly as today; `npm run test` green including the updated
  arg-shape test.

Done 2026-09-30 by feature. As planned, plus one small shape note: `setConfigKey`'s success
value also carries the parsed value (`{ ok: true; value; oldValue }`) so `cmdConfig`'s
confirmation line names the parsed value exactly (`set model to "gpt-5"`), not the raw text.
The shared helper is `writeConfigMutation` in src/config-write.ts; `setDailyBudgetUsd` and
`setConfigKey` both sit on it.

### Hand in-flight fallback ticks back to the primary at `budget_resumed` (planned 2026-09-30, done 2026-09-30)

**Goal.** When local midnight reopens the budget, `pollBudgetGate` flips new ticks back to the primary, but a tick that started on the fallback keeps it until it ends ("In-flight ticks finish; only NEW ticks are gated", src/budget-gates.ts). On 2026-09-30, three ticks started under the 09-29 fallback held their permits on the slow local model after midnight: steward until 00:06, plan until 00:21, telemetry until 01:20 (a 12,588 s tick; that role's primary ticks take minutes). The fleet's fresh budget ran on no permits for the first 6 minutes (no role tick started between 00:00:01 and 00:06:01), one permit for the next 15, and two for the next hour, while oMLX stayed busy. The operator asked why oMLX was still running on a new day. Hand those ticks back: interrupt them resumably and let their next tick continue the same session on the primary.

**Approach.**
- src/loop.ts: capture the model a tick runs on. `runTick` already snapshots `cfg = configForRole(this.config, this.role)` at tick start; store its provider/model pair on the runner (transient, not persisted) and expose it (e.g. `tickModel(): { provider?: string; model?: string } | null`, null when no tick is running).
- src/loop.ts: add `handBackTick()` beside `abortTick()`. Same guard (`state.running`), but it aborts `tickAbort` without setting `userAborted`. So `finishAbortedTick` takes its shutdown branch (pi session and worktree edits kept) and `applyTickOutcome`'s `"aborted"` arm sets `resumePending` and `nextRunAt = now`, the path redeploy's drain already exercises. Give the resume its own cause so the bridge prompt tells the truth: add `"budget-resumed"` to `LoopState.resumeCause` and to src/prompt.ts's `ResumeCause`/`buildResumePrompt`. Suggested wording: your run was moved from the local fallback to the primary model; your session and edits are intact, so continue where you left off.
- src/budget-gates.ts: `BudgetGatePoll` gains `resumed: boolean`, true only on the poll whose transition logs `budget_resumed` (prevGate was `fallback` or `paused`, gate now `open`), plus the fallback pair it left (`fallbackPair(liveConfig)`, src/config-views.ts).
- src/orchestrator.ts: on a `resumed` poll, call `handBackTick()` on every non-director runner whose `tickModel()` equals that pair. Log one `budget_handback` event `{ roles, provider, model }` so the digest and `logs` explain the resulting aborted ticks. Landings (the orchestrator's slot runs) and the director are untouched.
- src/event-format.ts: render `budget_handback` in `logs`/the feed ("budget reopened: handed <roles> back to the primary").

**Files touched.** src/loop.ts, src/budget-gates.ts, src/orchestrator.ts, src/prompt.ts, src/event-format.ts, src/loop-state.ts and src/tick-outcome.ts (both spell the `resumeCause` union), test/budget-gates.test.ts, test/loop.test.ts (or the loop test file that covers abortTick), test/prompt.test.ts.

**Acceptance criteria.**
1. `pollBudgetGate` returns `resumed: true` on exactly the fallback→open (and paused→open) poll and `false` on every other poll, pinned in test/budget-gates.test.ts.
2. `handBackTick()` on a running loop ends its tick `aborted` with `resumePending: true`, `resumeCause: "budget-resumed"`, and the worktree's uncommitted edits intact. On an idle loop it is a no-op. The next tick passes `--continue` and the primary's `--provider/--model` (fake-pi argv capture).
3. The orchestrator hands back only runners whose captured tick model is the fallback pair: a tick started on the primary (or the director) keeps running. It logs one `budget_handback` naming them.
4. `buildResumePrompt(role, "budget-resumed")` names the model move; the existing causes' texts are unchanged.
5. Manual check before calling it done: continue a real oMLX-started session with `pi --continue --provider huggingface --model <primary>` once, to confirm pi carries the history across providers. If it cannot, say so in Done and fall back to a fresh tick (drop `--continue` for this cause).

Size: one run, ~120 lines of source plus ~6 tests. The gate change is pure. The runner method reuses the existing abort path.

Done 2026-09-30 by feature: implemented as planned. Deltas from the written approach: the
pair-matching predicate is a small exported pure helper, `tickOnPair`, in src/budget-gates.ts
(pinned in test/budget-gates.test.ts), so the orchestrator's handback wiring is one filter call;
the loop e2e landed in test/loop-5.test.ts (the file that covers abortTick) and the fleet-level
wiring is pinned end to end in test/orchestrator-budget.e2e.test.ts (in-flight fallback tick →
budget_handback naming the role and pair → resumably aborted → resume with `--continue` on the
budgeted pair), which the entry's files list did not name; test/event-format.test.ts pins the
`budget_handback` rendering and docs/how-it-works.md's fallback bullet names the handback.
Criterion 5's manual check — continuing a real oMLX-started session with the primary pair — was
NOT run: a harness tick never calls a real model (PRINCIPLES.md), and no oMLX backend is
guaranteed reachable here. The code keeps `--continue` for this cause (pi's session files are
provider-independent on disk); if a real handback ever shows pi refusing a cross-provider
continuation, the fallback is one line: map the "budget-resumed" cause to a fresh tick (skip
`--continue`) in runTick's resume decision, and record that here.

### `npm run test:coverage`: a coverage report through the suite's own runner, so coverage ticks stop hand-building raw `node --test` runs (planned 2026-09-30, done 2026-09-30)

**Goal.** The coverage role's prompt (src/roles.ts) says to "run the test runner's coverage report when it has one (Node: `node --experimental-test-coverage --test …`)". tumwater's runner has none, so coverage ticks improvise one. On 2026-09-30, tick 410 copied part of `suiteEnv` by hand (`env -u TUMWATER_PI_BIN -u TUMWATER_SUPERVISED GIT_TEMPLATE_DIR=… GIT_CONFIG_*`), compiled to `/tmp` with `--outDir`, and ran the unit files with raw `node --test`. It then retried per file under `timeout 240`, but `timeout` is not installed on macOS. The tick took 131 turns and 101 minutes, and the out-of-tree build ran real pi agents on oMLX (BUGS.md, the dangling-script-shim entry). Give the runner a coverage mode so the correct path is also the cheapest one, and put it where the agent looked: it grepped package.json's `"test"` line first.

**Approach.**
- test/test-runner.ts: extract the node argv that `main()` builds into an exported pure helper, e.g. `buildNodeTestArgs(sel, { reporter, fresh, tap, coverage })`, so the flag is unit-testable without running a suite. `main()` strips `--coverage` from `process.argv.slice(2)` before `selectTestFiles`, so it composes with every filter form (`--coverage loop`, `--coverage e2e`, `--coverage 'pi#resume'`). With it, the args gain `--experimental-test-coverage` (available on the `>=20.3` engines floor). When the running Node is at least 22.5, they also gain `--test-coverage-exclude=**/test/**`, so the table reports src rather than the test files. On older Node, the full table prints. `suiteEnv`, `SUITE_TIMEOUT_MS`, `orderByDuration`, and the empty-`#name` guard are unchanged.
- Skip `recordDurations` under `--coverage`: instrumentation slows every file, and recording it would skew future `orderByDuration` ordering.
- package.json: `"test:coverage": "node scripts/live-checkout-guard.mjs && tsc --incremental && node scripts/stamp-build.mjs && node dist/test/test-runner.js --coverage"`. No eslint, since this is a report, not a gate. `npm run test:coverage -- <filter>` passes filters through.
- DEVELOPMENT.md: one line in the command block (`npm run test:coverage [filter]  # the unit suite with node's coverage table`), and a sentence saying coverage runs go through the runner, never raw `node --test` or a tree compiled elsewhere. The fakes resolve their shim relative to `dist/` inside the checkout.

**Files touched.** test/test-runner.ts, package.json, DEVELOPMENT.md, test/test-runner.test.ts.

**Acceptance criteria.**
1. `npm run test:coverage` runs the unit tier under `suiteEnv` and ends with node's coverage table. Its exit status follows the suite's, so a failing test still fails the run.
2. `npm run test:coverage -- <filter>` selects exactly what `npm test -- <filter>` selects.
3. A `--coverage` run leaves `dist/test/.durations.json` unchanged.
4. test/test-runner.test.ts pins `buildNodeTestArgs`: `--experimental-test-coverage` appears only with `coverage: true`; the exclude flag appears only when the version predicate allows it; the `#name` reporters are still added under coverage. It also pins the argv split: `--coverage` is removed from the filters and composes with one.
5. DEVELOPMENT.md names the command.

Size: one run. ~40 lines in the runner (mostly the extracted args builder), one script line, two DEVELOPMENT.md lines, ~4 tests.

Done 2026-09-30 by feature: implemented as planned (`splitCoverageArgv` and `nodeSupportsTestCoverageExclude` exported as the pure split and version predicates the criteria name). A spawned-runner test runs `dist/test/test-runner.js --coverage json-object` and pins the table (kept to src by the exclude flag on node 26) and the untouched durations ledger; a full `npm run test:coverage -- json-object` run confirmed the script composes with a filter.

### `tumwater history --grep <text>` — the tick-table filter its sibling `logs --grep` already has (planned 2026-09-30, done 2026-09-30)

**Goal.** An operator asking "which ticks touched the flaky test?" or "when did a loop last fail with a merge conflict?" has no filter over the tick table: `tumwater history` prints the last N rows or a `--since` window wholesale, while the event-log view (`logs --grep`, landed 2026-09-28) filters case-insensitively against the same rendered line the operator would otherwise read. Give history the same filter so both observing views answer substring questions the same way.

**Approach.** Mirror `logs --grep`'s semantics exactly, in `cmdHistory` (src/ui/history.ts):

- `--grep <text>` filters the row set case-insensitively as a substring against the WYSIWYG row text — the string `renderRow(row, widths)` produces, plus a prefix of the raw event type so stable ids (`tick_end`) are greppable too. Filter runs on the collected `TickRow[]` before rendering and before `--json` serialization (compose with `--json`: filtered rows, same `{rows}` payload).
- Composes with everything history already has: `-n` bounds the **scanned** window, not the printed rows (grep shows only matching rows among the last N — the `logs --grep` rule); `--since` filters the window then greps; `--role` is a row filter and composes. No rival shapes to reject (history has no transcript view to collide with).
- Parsing mirrors log-commands.ts's impersonation guard: with `--grep` present, drop the value's position from the flag scan (`rest`) so a pattern spelling a rival flag (`history --grep -n`) is text, not a flag; a valueless or empty `--grep` fails with wording shaped like `GREP_VALUE_ERROR` (src/ui/log-commands.ts) — "history --grep needs a pattern" — but as a local constant in history.ts, not an import, so the two views' wordings name themselves.
- No change to `readTickRows`/`readTickRowsSince` (src/history-data.ts): filtering is a view concern over collected rows.
- Extend the `tumwater history` stanza in `HELP` (src/help.ts) — the helpStanzas split derives `help history` from it, so the topic stays in sync automatically.

**Files touched.** src/ui/history.ts (the flag, the filter, the error constant), src/help.ts (one stanza line), test/cli-history.test.ts (new cases).

**Acceptance criteria.**
1. `tumwater history --grep <text>` prints only rows whose rendered line (or `tick_end`) matches, case-insensitively; a pattern containing `--` (e.g. `--grep --since`) is treated as text.
2. `--grep` composes with `-n` (scan-bounded), `--since` (window-filtered then grepped), `--role`, and `--json` (filtered payload, still `"rows":[]`-shaped when empty).
3. `history --grep` with no value exits 1 with "history --grep needs a pattern"; an empty-match run prints the existing `no ticks yet` / `no ticks in <window>` lines, unchanged in wording.
4. `tumwater help history` shows the new flag; the full `HELP` listing and the topic cannot disagree (derived).
5. New tests in test/cli-history.test.ts cover: filter match/no-match, composition with `-n` and `--since` and `--json`, and the valueless-`--grep` failure — all against the existing fake-harness fixtures the file already builds.

Size: one run — ~60 lines in history.ts, one help line, ~5 test cases.


Implemented as planned: `cmdHistory` (src/ui/history.ts) gains `--grep <text>` — a case-insensitive substring filter over the WYSIWYG row line plus a `tick_end` prefix, with log-commands.ts's impersonation guard (the pattern's position is dropped from every later flag scan, so `history --grep --since` greps for "--since") and a local `HISTORY_GREP_VALUE_ERROR` ("history --grep needs a pattern", exported for cli.ts's rejectUnknownArgs spec, worded locally rather than imported so the two views name themselves). The filter runs on the collected `TickRow[]` before rendering and before `--json` serialization, so it composes with `-n` (scan-bounded), `--since` (window-then-grep), `--role`, and `--json` (filtered payload, still `{"rows":[]}` when empty); empty-match table runs keep the existing `no ticks yet` / `no ticks in <window>` prose. The haystack renders each row with its own widths (padToWidth is the identity there), the canonical unpadded line, because the filter runs before the shown rows' widths are known. `src/help.ts`'s history stanza names the flag (the derived topic follows), and README.md's usage-table row gained the flag too — one file beyond the entry's list, for doc accuracy. Tests in test/cli-history.test.ts cover match/no-match, the flag-shaped pattern, `-n`/`--role`/`--since`/`--json` composition, and the valueless/empty-value failure (8 new cases).

### `tumwater diff` fleet-wide — one line per loop holding pending work, no `--role` needed (planned 2026-09-29, done 2026-09-30)

- **Goal.** Between a loop's commit and its merge, its work lives only on its branch and
  worktree. The Done entry "`tumwater diff --role <id>` — show the change a loop holds"
  (planned/done 2026-09-29, above) answers that for one named loop, but a fleet-wide "what
  is every loop about to land?" still means querying each role by hand — the one fleet view
  without an all-roles form, since every other one (status, logs, history, backlog, report)
  has it. Give `tumwater diff` a no-`--role` form: one line per loop that holds pending
  work, and `--json` prints the roster as data. This plan builds on that Done entry's
  module, `src/ui/change-preview.ts`; it changes nothing about the per-role view.
- **Approach.** In src/ui/change-preview.ts, beside `collectRoleChange`/`renderRoleChange`,
  add: a `FleetRoleChange` interface — one entry per role with `role`, `branch`, `state`
  (`"absent" | "no-base" | "ready"`, the RoleChangeView states), `ahead`, `commits`
  (`{sha, subject}[]`), `dirtyFiles` — i.e. the RoleChangeView fields minus the
  `diff`/`uncommittedDiff` patch strings (the patches stay in the per-role view; a
  fleet-wide patch dump would be 13 roles × 200 KB); a `FleetChangeView` of
  `{mainBranch: string, roles: FleetRoleChange[]}`; a `collectFleetChanges(root)` that
  maps `knownRoleIdsCached(root)` (src/config.ts — built-in plus custom loop ids, config
  order; disabled roles included, since a loop stopped mid-flight still holds its branch)
  to `collectRoleChange(root, role)` and drops the two patch fields per entry — reusing
  `collectRoleChange` keeps the `absent`/`no-base` degradation logic single-homed, and the
  patch git-diffs it computes for nothing only run for roles actually holding work, each
  capped by the module's `DIFF_MAX_BYTES`; and a `renderFleetChange(views)` that skips
  entries that are `no-base` or hold nothing (`ahead === 0 && dirtyFiles.length === 0`),
  prints one line per remaining role in roster order — `<role>: <ahead> commit(s) ahead of
  <mainBranch>`, gaining `, <n> uncommitted file(s)` when `n > 0` (pluralization via
  src/text.ts's `plural` where it fits) — prints `no pending changes` when no line remains,
  and reuses the per-role `main branch <name> does not exist` line when every entry is
  `no-base` (`mainBranch` resolves fleet-wide in `resolveMainBranch`, so that condition is
  fleet-wide) — every degraded case exit 0, like the per-role view. In src/cli.ts's
  `case "diff"`: `parseRoleFlag` already returns null for an absent flag and fails on an
  empty or unknown value, so replace the `if (role === null) fail("diff needs --role…")`
  branch with the fleet path — absent `--role` runs `sayJsonOrRender(args, await
  collectFleetChanges(root), renderFleetChange)`; present `--role` keeps the existing
  `collectRoleChange` path untouched; the `rejectUnknownArgs` spec is unchanged. In
  src/help.ts add a `  tumwater diff [--json]` stanza (one line per loop holding pending
  work — ahead-of-main commit count and uncommitted-file count, no patch; the `--role`
  form is the full view; `--json` prints the `{mainBranch, roles}` roster) above the
  existing `--role` form; `helpStanzas`/`helpTopic` group both under `diff` because both
  carry the same command token, like `logs`' two forms. In README.md extend the usage
  table's diff row to note that without `--role` it lists every loop's pending change in
  one line each. In test/cli-diff.test.ts (existing; the "fails fast" test at its
  `missing` case currently pins the old behavior) update that test so a bare `diff` no
  longer fails — the missing-`--role` failure assertions are replaced, while empty
  `--role`, unknown role, and stray-flag failures keep their existing wording — and add:
  on a seeded repo where the feature worktree holds one unlanded commit plus one dirty
  file (the file's `seededFeatureRepo`-style setup, plus a dirty append), `tumwater diff`
  exits 0 printing exactly the `feature` line with both counts and no lines for other
  roles; with nothing pending anywhere it prints `no pending changes` (exit 0); a
  configured-missing baseBranch (the existing test's `ghost` setup) prints
  `main branch ghost does not exist` (exit 0); `tumwater diff --json` parses to
  `{mainBranch, roles}` with `mainBranch` `"main"`, one entry per known role in
  `knownRoleIdsCached` order, the holding role carrying `ahead`/`commits`/`dirtyFiles`,
  and no `diff`/`uncommittedDiff` keys on any entry.
- **Files touched.** src/ui/change-preview.ts (+~70 lines: the two interfaces,
  `collectFleetChanges`, `renderFleetChange`), src/cli.ts (+~10 in `case "diff"`),
  src/help.ts (+1 stanza), README.md (1 usage-table line), test/cli-diff.test.ts
  (+~110 lines including the updated fail-fast test).
- **Acceptance criteria.**
  1. On a seeded fleet where the feature worktree holds one unlanded commit and one dirty
     file and no other role holds work, `tumwater diff` exits 0 printing exactly one
     pending line — `feature: 1 commit ahead of main, 1 uncommitted file` — with no lines
     for other roles; with nothing pending anywhere it prints `no pending changes`.
  2. A configured-missing baseBranch prints `main branch <name> does not exist` (exit 0);
     empty `--role`, unknown role, and unknown flags still fail with the existing
     wording; `tumwater diff --role <id>` output is byte-identical to before.
  3. `tumwater diff --json` prints the roster: `mainBranch` names the resolved baseline,
     `roles` holds one entry per known role in `knownRoleIdsCached` order with
     `state`/`ahead`/`commits`/`dirtyFiles` and no patch fields.
  4. `npm run test` passes; `tumwater help diff` shows both forms.
- **Done 2026-09-30 (feature).** Implemented as planned, one deviation: the two new
  interfaces (`FleetRoleChange`, `FleetChangeView`) stayed module-internal (no `export`)
  because the exports lint requires every exported symbol to be used outside its own file
  and the CLI and tests consume `collectFleetChanges`'s return type structurally.


### `tumwater diff --role <id>` — show the change a loop holds: its branch's unlanded commits and its worktree's uncommitted edits (planned 2026-09-29, done 2026-09-29)

- **Goal.** Between a loop's commit and its merge, the change lives only on the role's branch —
  and mid-tick, uncommitted edits live only in its worktree. The dashboards show a text label
  for this (the GUI drawer's `landingSummary`) but no operator surface shows the actual change:
  an operator auditing "what is the feature loop about to land?" must git-spelunk
  `.tumwater/worktrees/<role>` by hand. Every other fleet view (status, logs, history,
  backlog, report) is a CLI command; the pending change is the one view without one. Give it
  `tumwater diff --role <id>`.
- **Approach.** Everything the command needs already exists; this plan wires it, it invents
  nothing. New src/ui/change-preview.ts exports `collectRoleChange(root, role)` and
  `renderRoleChange(view)`: resolve `mainBranch` the way doctor's checkRepo resolves the
  fleet's target — a configured `baseBranch` in tumwater.json wins (`run --branch` is
  per-invocation and invisible to a later CLI query), then `currentBranch(root)` (src/git.ts),
  then "main" — so the diff compares against the branch the fleet actually lands on; a
  resolved main that does not exist degrades to a `main branch <name> does not exist` line
  (exit 0). The role's branch and worktree come from
  `branchName(role)` and `worktreePath(root, role)` (src/paths.ts). When the worktree dir is
  missing or `gitTry(wt, "rev-parse", "--git-dir")` returns null, the view is `absent` — a
  fresh fleet or never-run loop renders `no worktree for <role>` (exit 0), so the command
  degrades like report does rather than requiring a ready repo. Otherwise collect both halves:
  the committed half via `aheadOfMain(wt, mainBranch)` (src/git.ts),
  `gitTry(wt, "log", "--oneline", "<main>..HEAD")` for the subject list, and
  `aheadOfMainDiff(wt, mainBranch)` (src/git-diff.ts) for the patch — its existing 200 KB cap
  with the --stat-plus-largest-files fallback is reused verbatim, so the output can never be
  unbounded; the uncommitted half via `changedFiles(wt)` (src/git-diff.ts, porcelain) for the
  file list and `gitTry(wt, "diff", "HEAD")` capped the same way for the patch — `HEAD` so a
  staged edit shows in the patch its porcelain file list already counts (plain `git diff`
  covers unstaged only; untracked paths appear in the file list alone). The render prints the
  commit log one line per commit, the committed patch, then `uncommitted (N files)` with the
  same shape; when both halves are empty it prints `no pending change for <role>`. In
  src/cli.ts add `case "diff"`: no `requireReadyRepo` gate (absent worktrees degrade, per
  above), `rejectUnknownArgs` with the shared `ROLE_FLAG` spec, `parseRoleFlag` for the value
  — `--role` is required here, so an absent value fails with the existing
  `ROLE_VALUE_ERROR` wording, and a missing `--role` fails pointing at `tumwater help diff`.
  `--json` prints
  the collector's own payload (`{role, branch, mainBranch, state, ahead, commits: [{sha,
  subject}], diff, dirtyFiles, uncommittedDiff}` — `mainBranch` names the baseline the diff
  was computed against, and `state` is `absent` (no usable worktree), `no-base` (resolved
  main branch missing), or `ready`), following the `--json` series' collector-payload rule. Add
  the HELP stanza in src/help.ts (one form, under the logs/history family) and a README usage
  table row so the doc stays accurate.
- **Files touched.** src/ui/change-preview.ts (new, ~90 lines), src/cli.ts (+~12),
  src/help.ts (+1 stanza), README.md (+1 table row), test/cli-diff.test.ts (new, ~130 lines,
  built on test/repo-fixtures.ts and test/cli-harness.ts like the other CLI command tests).

  First landed 2026-09-29, rejected in review on two points, re-landed the same day: the
  baseline now resolves `baseBranch`-first like doctor/status instead of
  `currentBranch(root) ?? "main"` (with a `no-base` degrade for a configured-but-missing
  branch, and `mainBranch` added to the JSON payload so scripts see what was compared
  against), and the uncommitted patch uses `git diff HEAD` so a staged edit is actually in
  the patch its file list counts. Tests pin both fixes: the baseBranch-counts-differently
  case and the staged-only-edit case.
- **Acceptance criteria.**
  1. On a seeded fleet, a commit on `tumwater/feature` ahead of main makes
     `tumwater diff --role feature` print that commit's subject and a patch naming its
     changed file; a dirty worktree adds the `uncommitted (N files)` section naming the dirty
     paths; both empty prints `no pending change for feature` (exit 0).
  2. A role with no worktree yet prints `no worktree for <role>` (exit 0); missing or empty
     `--role` fails with the usage line / ROLE_VALUE_ERROR; an unknown flag is rejected.
  3. `tumwater diff --role feature --json` prints the payload above with `ahead` and the raw
     diff as data.
  4. `npm run test` passes; the new stanza appears in `tumwater help` and `tumwater help diff`.

### `tumwater history --since <duration>` — window-shaped tick history, completing the `--since` pattern (planned 2026-09-29, done 2026-09-29)

- **Goal.** `tumwater history` answers "the last N ticks" only: an operator auditing "what
  happened since the last failed landing" or "over the last hour" must guess a count. The two
  sibling observability commands already speak durations — `logs --since <duration>` and
  `report --since <duration>` (both capped at 7d) — so history is the odd one out. Give it the
  same window shape over the same record.
- **Approach.** Everything the window needs already exists; this plan wires it, it invents
  nothing. In src/history-data.ts (113 lines) add `readTickRowsSince(root, sinceMs, role)`
  beside `readTickRows`, mirroring cmdLogs' since path (src/ui/log-commands.ts lines 90–113):
  `cutoff = Date.now() - sinceMs`; `readWindowEvents(root, dayKey(cutoff))` — the shared
  rotation-spanning reader (src/event-window.ts), so the archive `events.jsonl.1` is covered
  for free; filter events to `typeof e.ts === "number" && e.ts >= cutoff` (the day-keyed read
  may include earlier hours of the cutoff's day); then reuse the existing pure `tickRows`
  with `limit = events.length` (newest first, role filter intact) and return
  `{ rows, covered }` where `covered` is `eventWindowCovers(window, cutoff)` — the exact
  predicate cmdLogs uses, so the two surfaces cannot disagree about when the window is proven.
  In src/ui/history.ts's `cmdHistory`: `--since <duration>` is a rival shape to `-n`
  (same rule and wording shape as logs' "a count and a window are rival shapes"), parsed with
  the shared `parseDurationFlag` and capped with `failOverDurationCap` against the existing
  `LOGS_SINCE_MAX_MS` (reuse that constant — same log, same cap; no third cap value).
  `--role` composes with `--since` here (history's `--role` is a filter, not the rival view
  logs guards against), and `--json` works unchanged: an empty window prints nothing in JSON
  mode (`{"rows":[]}`, the report --json precedent) and `no ticks in <duration>` in table
  mode (reuse `durationLabel`, as cmdLogs does); when rows exist and `covered` is false,
  print cmdLogs' hedged note verbatim — "note: the log's oldest retained event lies inside
  this window; older events may have rotated out" — only in table mode, only after rows.
  Update the `rejectUnknownArgs` list for history in src/cli.ts (add
  `{ names: ["--since"], value: true, valueName: "<duration>" }`) and the HELP text's history
  line in src/help.ts to match. The GUI's /api/history stays count-shaped this round — the
  dashboard's history tab asks for rows, not windows; extending the endpoint is a follow-up
  only if an operator asks for it.
- **Files touched.** src/history-data.ts (+~35), src/ui/history.ts (+~25), src/cli.ts (+2),
  src/help.ts (+1 line of help text), test/history-data.test.ts and test/ui-history.test.ts
  (new window cases, ~80 total).
- **Done 2026-09-29 by feature, as planned.** Two deviations from the entry as written:
  the project consolidated history's tests into test/cli-history.test.ts (there are no
  test/history-data.test.ts or test/ui-history.test.ts files — the new window cases live
  there, ~100 lines), and the README's per-tick-history usage row was updated to show the
  new flag so the doc stays accurate. Help-text line wrapping keeps "machine-readable
  history data" on one line so the existing help-stanza pin keeps matching.
- **Acceptance criteria.**
  1. A seeded log spanning several days: `history --since 2h` returns exactly the tick_end
     events at or after the cutoff (role filter composes), newest first, with paired durations
     where the tick_start survives the read; `--json` emits the same rows with raw ts/tokens/
     costUsd and `{"rows":[]}` for an empty window.
  2. `--since` combined with `-n` fails with the rival-shape message; an over-cap or malformed
     duration fails through the shared helpers with the same wording shape logs --since uses.
  3. When the window's oldest retained event lies inside the window (rotation or idleness),
     the hedged note prints after the table in table mode only — never in `--json` output.
  4. No `--since`: behavior is byte-identical to today (default 20 rows, `-n` ceiling 200,
     existing tests pass unchanged).
  5. `npm run test` green.

### Windowed event reads span the rotation boundary: `readWindowEvents` continues into `events.jsonl.1` (planned 2026-09-29, done 2026-09-29)

- **Goal.** Every windowed consumer of the event log — `logs --since`, the usage report's
  `--days`/`--since` collectors, the failure digest's day-windowed pass, and the GUI endpoints
  that reuse them — reads only the live `events.jsonl`. The log rotates at 16 MB into
  `events.jsonl.1` (files.ts `rotateIfLarge`), and on a busy fleet a 16 MB file holds less
  than the default 14-day window, so the readers silently degrade to a truncated view plus a
  "note: older events may have rotated out" line even though the missing events sit right
  there in the archive on disk. The archive is written today and read by nothing.
- **Approach.** `readWindowEvents` (src/event-window.ts) already scans the live file backwards
  in chunks with an early stop and computes `coversFullWindow`. Split the per-file backwards
  scan into a helper and call it twice: after the live-file scan, while `coversFullWindow` is
  still false, scan `events.jsonl.1` the same way; its in-window events are strictly older
  than the live file's, so prepending them keeps the oldest-first ordering every consumer
  assumes, and the dedup-free concatenation is safe because rotation moves the whole file —
  the two files share no lines. `coversFullWindow` becomes true when either file's oldest
  retained event predates the window, so the existing rotation note (`ui/report.ts` line ~81,
  `ui/log-commands.ts`'s covered check) stays exactly right in both directions: it vanishes
  once the archive completes the window and still appears when even the archive starts inside
  it. Add `eventsArchivePath` (root) → `eventsLogPath(root) + ".1"` to src/paths.ts as the
  single home beside `eventsLogPath` — keep the one-archive retention as is (opinionated
  default; the note still tells the truth when the archive itself is not old enough).
  No consumer changes: src/ui/log-commands.ts, src/report-data.ts (both call sites), and
  src/failure-data.ts get archive coverage through the shared reader unchanged. The
  count-bounded scans (`readEvents`' default tail, history-data.ts's window ladder) are out
  of scope — they answer "the last N ticks", not a time window.
- **Files touched.** src/paths.ts (+4), src/event-window.ts (restructure of `readWindowEvents`,
  roughly +40 net), test/event-window.test.ts (new rotation-boundary cases, ~100).
- **Acceptance criteria.**
  1. A fixture planting `events.jsonl.1` (older days) beside a live `events.jsonl` (today):
     `readWindowEvents` with a window spanning the boundary returns events from both files,
     oldest-first, in-window only; `collectReport`'s per-day series sums to the seeded totals
     across the boundary.
  2. `coversFullWindow` is true when the archive's oldest event predates the window start and
     false when the archive's oldest event is still inside it — the report's and
     `logs --since`'s rotation notes track it in both directions.
  3. Missing or empty `events.jsonl.1` (the normal case): `readWindowEvents` returns exactly
     today's `{ events, coversFullWindow }` behavior — the existing test/event-window.test.ts
     cases pass unchanged.
  4. Torn/corrupt lines in the archive follow the same skip policy as the live file
     (`parseEventLine`), and a window that lies entirely inside the live file never touches
     the archive.
  5. `npm run test` green.

### Count the landing slot's spend in the usage report: `landed`/`land_failed` usage folds into `tumwater report` totals, with a reviewer-and-conflict-resolution breakdown line (planned 2026-09-29, done 2026-09-29)

**Goal.** The usage report claims to answer "where did the money go", but it counts only
`tick_end` events: `src/report-data.ts` `foldUsageEvent` handles `tick_end` and `merged` and
nothing else, while the landing slot stamps the reviewer's and conflict-resolution runs'
tokens and cost onto the `landed`/`land_failed` events it logs (`src/landing-slot.ts`
`writeLandingOutcome`, `...(usage.tokens > 0 ? { tokens: usage.tokens } : {})` — the same
`eventUsage`-compatible keys `tick_end` carries). Every landed change goes through the
landing slot, so a busy fleet's reviewer spend — often a large share of total cost — is
invisible in `tumwater report`, `report --since`, and their `--json` payloads, while the
daily budget *does* charge those same runs (`src/tick-usage.ts` `fold` →
`recordDailyCost`, reached via `src/loop.ts` `foldLandingUsage`). The operator sees a report
smaller than the budget header's day spend with nothing explaining the difference. This plan
folds landing usage into the report totals and shows it as its own line, so the report and
the budget finally agree and the reviewer's share of spend is visible.

**Approach.**

1. **Collector (`src/report-data.ts`).** Extend `foldUsageEvent`: on `landed` or
   `land_failed`, add `eventUsage(ev)`'s tokens/cost to two new accumulators on `UsageFold`
   (`landingTokens`, `landingCostUsd`) — NOT to the existing totals fields, so the fold stays
   one pass — and count events as `landingRuns` the way `ticks` counts `tick_end` (the day
   collector passes `ticks: undefined`; mirror that with a `landingRuns?: number` field).
   Then `collectReportSince` adds the three fields to `SinceReport`'s surface
   (`landingRuns`, `landingTokens`, `landingCostUsd`) and `collectReport` folds them into each
   `ReportDay` (`tokensOut`/`costUsd` per day grow by the landing amounts, keeping the day
   series summing to totals) plus day-level `landingCostUsd` for the series bar context.
   Totals semantics: `totals.tokensOut` and `totals.costUsd` INCLUDE landing spend from the
   same events the budget charges, so report == budget; the separate landing fields say how
   much of it was reviewer/conflict work. No double counting exists by construction: landing
   runs fold after their tick's `tick_end` fired (the authoring tick ends `queued`), and the
   landing accumulator only ever sees the slot's own pi runs.
2. **Renderers (`src/ui/report.ts`).** `renderReportMarkdown` and
   `renderSinceReportMarkdown` each gain one line under the Totals line, e.g.
   `of which landing runs: 12 runs · 45.2k tokens · $0.84 (reviewer + conflict resolution)` —
   omitted entirely when `landingRuns === 0` (the same zero-means-absent rule the cost-by-role
   line follows), so a fleet with no landing spend renders exactly as today. The `--json`
   payloads need no renderer work: they print the collector's object, which now carries the
   new fields.
3. **Docs (`src/help.ts`, `README.md`).** The `report`/`report --since` stanzas say "tokens
   counts work ticks; totals also include landing runs (reviewer + conflict resolution)" in
   one added sentence — the help text's existing habit of naming what a number counts
   (`-n` bounds the scanned window, not the printed rows).

**Note 2026-09-29, feature run.** Landed with three deviations from the draft, none changing
the acceptance criteria: (1) the day series carries `landingRuns` and `landingTokens` as well
as `landingCostUsd` (all sparse — absent until the day folds a landing event), because the day
report's totals line needs the run count and there is no per-role map a day could derive it
from, unlike ticks/`ticksByRole` — so `foldUsageEvent` counts `landingRuns` on every fold
target rather than gating it the way `ticks` is; (2) the day's `tokensOut`/`costUsd` grow by
the landing amounts right after the event pass (the budget charges these same events, so the
series keeps summing to the totals), while `collectReportSince` combines the landing
accumulators into its surfaced totals itself; (3) the type-literal fallout ran wider than
exact-field-set assertions: the `ReportData`/`SinceReport` literals in test/report.test.ts
(totals gained the three required fields) and the one `ReportData` literal in
test/gui-report.test.ts needed updating, so that file joins the touched list for real.

**Files touched:** `src/report-data.ts`, `src/ui/report.ts`, `src/help.ts`, `README.md` (the
usage table's report row), `test/report.test.ts`, `test/gui-report.test.ts` (its `ReportData`
literal gained the totals fields).

**Acceptance criteria.**

- A fixture log holding one `tick_end` (tokens A, cost a) and one `landed` (tokens B, cost b)
  yields a report whose totals read A+B tokens and a+b cost, with the landing line showing
  exactly B/b and 1 run; `land_failed` with usage folds identically; `merged` still counts
  only as a commit.
- `report --since` behaves identically over a trailing window, and both `--json` payloads
  carry `landingRuns`/`landingTokens`/`landingCostUsd` (day series carries `landingCostUsd`).
- A log with no `landed`/`land_failed` events renders byte-identical to today's output (no
  landing line, totals unchanged).
- The failure digest is deliberately untouched: its time-and-spend fold stays tick-shaped
  (`tick_end` only) — a landing is not a tick, and its outcome table keys on tick results.
- `npm run test` passes, including the updated report fixtures. — All met (suite 2183/2184, 1 skipped).


### Fleet-wide backend-failure hold: extend the 429 storm hold to connection, 5xx, and model-load failures (planned 2026-09-29, done 2026-09-29)

**Goal.** The only cross-role failure response is the 429 storm hold (src/rate-limit-hold.ts `rateLimitHold`, fed by `transientRateLimit` in src/pi-stream.ts via src/tick-usage.ts `lastRateLimit`). Other backend-wide failures are unclassified: "Connection error.", "Request timed out", 5xx "Internal Server Error", "Failed to load model", and memory-guard rejections or aborts. Each fails every role separately, and each role backs off on its own `ERROR_BACKOFF` ladder. That is ~100 ticks all time (mostly the local-model era) and 7 in the last week ([docs/commit-history-analysis.md](docs/commit-history-analysis.md)). When one backend is down, every role learns it separately.

**Approach.** (refined 2026-09-29: pinned the event shape, the kind semantics, and the memory-guard scope; dropped a status-header badge the code never had — the events already surface the hold.)
- src/pi-stream.ts: add `transientBackend = false` beside `transientServerTimeout`/`transientRateLimit` (the flags block near line 111) and a module-private `TRANSIENT_BACKEND` regex beside the existing ones near line 50, matching the error texts pi actually surfaces: connection error/refused/reset, `Request timed out`, the 5xx phrases (`Internal Server Error`, `Bad Gateway`, `Service Unavailable`, `Gateway Timeout`), and `Failed to load model`. Set the flag in the same `for` loop that checks the other two (near line 199), alongside `TRANSIENT_RATE_LIMIT`. Keep rate-limit matched separately and checked first, so a 429 stays a 429. Memory-guard failures are out of scope: no src/ code classifies them today, so there is no text to match.
- Export a pure `backendKind: "connection" | "timeout" | "server" | "model-load"` classifier on PiStreamParser (a small function beside `RETRY_AFTER`'s use), so the observation carries a kind without re-matching the text later. `retryAfterSeconds` stays undefined for backend kinds.
- src/tick-usage.ts `fold`: beside the `lastRateLimit` stamp, add `lastBackendFailure?: { at: number; kind: BackendFailureKind }`, stamped under the same rule — `run.transientBackend && !run.ok`, with `at: Date.now()`.
- src/rate-limit-hold.ts: generalize rather than add a second reducer. `RateLimitObservation` gains `kind: "rate-limit" | BackendFailureKind`; `RateLimitHold` gains `kind: string` (null-while-open like `until`). In `rateLimitHold`'s storm filter, observations count toward one storm only when their kinds match, and `roles` collects within that kind; `retryAfterMs` is unchanged (backend kinds carry no hint). A relapse is a new storm **of the same kind** within `RATE_LIMIT_RELAPSE_MS` of the re-open — a different kind starts fresh at the base. Rename the exported surface honestly: `rateLimitHold`→`fleetHold`, `RateLimitHold`→`FleetHold`, `RATE_LIMIT_OPEN`→`FLEET_OPEN`; call sites are only src/tick-timing.ts, src/orchestrator.ts (the `rateHold` declaration and `pollRateLimitHold` call), and the tests.
- src/tick-timing.ts `pollRateLimitHold`: gather each runner's `lastRateLimit` (kind "rate-limit") and `lastBackendFailure` into one observations array. Keep the existing event types — no `backend_hold`/`backend_resumed` pair — but add `kind` to the `rate_limit_hold` event payload (src/events.ts widens the payload type).
- Render the kind where the events render: src/event-format.ts `case "rate_limit_hold"` (near line 159) and src/failure-state-change.ts `case "rate_limit_hold"` (near line 93) lead with the kind for non-rate-limit holds, e.g. `backend hold (connection error) — <roles> …`; a `"rate-limit"` kind keeps today's exact wording. No new event types means src/ui and the digest need no other change.
- The director's exemption is untouched: its observations still count as evidence (src/tick-timing.ts already includes the director's runs), and the gating sites in src/orchestrator.ts (`startHeld` near line 388 and the `usesSlot` check near line 575) are unchanged.

**Note 2026-09-29, feature run.** Landed with five deviations from the draft, none changing the acceptance criteria: (1) `BackendFailureKind` is defined in src/pi-stream.ts beside the `backendKind` classifier and re-exported through src/pi.ts with `PiRunResult` (which now carries `transientBackend` + `backendKind`, threaded in `resultFromParser`'s single construction site); (2) `FleetHold.kind` is NOT null-while-open as drafted — nulling it at re-open would erase the one fact the same-kind relapse test needs (the re-opened state is what the next storm compares against) — so it holds the last hold's kind while open and is null only before the first hold; (3) `pollRateLimitHold`'s runner parameter became a structural exported `HoldInputs` type (src/tick-timing.ts) instead of `Pick<LoopRunner, …>`: the runner's hold getters are readonly and the test stands in plain mutable objects; (4) the shared kind phrase lives in src/text.ts (`backendKindPhrase`, beside `rateLimitHoldPhrase` — both renderers already import text.ts); (5) the hold-poll tests stayed in test/orchestrator-seams.test.ts, where they already lived, so that file joins the touched list instead of test/tick-timing.test.ts (which never tested the poll), alongside test/event-format.test.ts, test/failure-state-change.test.ts, and test/fake-pi.ts (the new result default).

**Files touched:** src/pi-stream.ts, src/pi.ts, src/tick-usage.ts, src/rate-limit-hold.ts, src/tick-timing.ts, src/loop.ts (the `lastBackendFailure` getter, beside `lastRateLimit`), src/events.ts (the rate_limit_hold comment), src/text.ts, src/event-format.ts, src/failure-state-change.ts, src/orchestrator.ts (rename only), and tests in test/pi-parser.test.ts (home of the parser unit tests since 2026-09-29, when test/pi-stream.test.ts merged into it), test/rate-limit-hold.test.ts, test/tick-usage.test.ts, test/orchestrator-seams.test.ts, test/event-format.test.ts, test/failure-state-change.test.ts, test/fake-pi.ts.

**Acceptance criteria.** The new regex classifies the listed connection/5xx/model-load texts and does not claim 429 texts. `fold` stamps `lastBackendFailure` only when the run ended on it, with the kind and no retry hint. Two distinct roles ending on the same backend kind within `RATE_LIMIT_STORM_WINDOW_MS` open a hold carrying that kind; two roles on *different* kinds, or two hits from one role, do not. A relapse of the same kind escalates and caps at `RATE_LIMIT_HOLD_CAP_MS`; a different kind after a hold re-opens starts at the base. A 429 storm behaves byte-for-byte as today (same hold math, same event wording). The `rate_limit_hold` event carries `kind`, rendered with backend wording in the feed and the digest. The director is not held. `npm run test` passes. — All met (suite 2155/2156, 1 skipped).

### Retire the README freshness stamp: `tumwater status` reports main's last green check (planned 2026-09-29, done 2026-09-29)

**Goal.** The readme role's contract (src/roles.ts, the `readme` role's `find`) makes the status section carry `Current main (<sha>): build clean, suite N/N`, and says "a moved main makes the stamp stale, so syncs still run after landings". Every landing therefore schedules a README commit. That is 184 of readme's 231 commits all time and 60 in the last 7 days (9% of all commits), and 1% of readme's lines survive ([docs/commit-history-analysis.md](docs/commit-history-analysis.md)). Volatile state does not belong in a committed file. The harness can report it live instead. Depends on the harness-attested suite counts plan above for the counts.

**Approach.**
- src/roles.ts `readme`: the status section carries (a) the capability summary and (b) the open-work pointer, and no stamp. Delete the "moved main makes the stamp stale" sentence. The readme role syncs when user-facing surfaces drifted (commands, flags, config keys, docs), and `git log <last readme commit>..main` replaces `<stamped sha>..main` as its delta, found via the role's own `Tick: readme #N` commit trailer. Update the pin in test/prompt.test.ts.
- src/ui/status.ts `snapshot`: add `mainCheck: { sha?, status, counts?, at }` — the newest `build_check` at the `landing`/`batch`/`baseline` scope in the event tail. The sha is the main commit the check verified: a `landed` event after the check names it (landing/batch checks run pre-merge), otherwise main's current tip (a baseline check runs ON the tip, and a later landing would have logged a newer check); the tip is read synchronously from the ref files, so src/git.ts's `currentBranchFromHeadFile` is now exported for it.
- A display-ready `mainCheckBadge` (` · main <sha>: green · N/N (N skipped)`) lives beside the other header badges in src/ui/status-model.ts and renders in the `tumwater status` header (src/ui/status-render.ts) and the GUI header (src/ui/gui-client.ts, via the payload's preformatted badge — the same pattern buildBadge uses).
- README.md: delete the stamp line from the managed status section in the same change. docs/how-it-works.md and the init template name no stamp, so they needed nothing.

**Files touched:** src/roles.ts, src/ui/status.ts, src/ui/status-payload.ts, src/ui/status-model.ts (the shared badge, added beyond the plan: the payload and the header must render one string), src/ui/status-render.ts (header), src/ui/gui-client.ts (header consumer, likewise added), src/git.ts (exported an existing private helper the sync snapshot needed), README.md, and tests in test/prompt.test.ts, test/status.test.ts, and test/status-render.test.ts.

**Acceptance criteria.** The readme prompt no longer mentions a freshness stamp or `<stamped sha>`. `status --json` carries `mainCheck` with the newest merge-scope check's sha, status, and counts (absent before any check). The status header renders it. README.md has no `Current main (` line. `npm run test` passes. — All met (suite 2134/2135, 1 skipped). First landed 2026-09-29 but rejected in review for a producer/consumer field mismatch — the sha derivation read the `landed` event's `sha`, a field production never logs (writeLandingOutcome logs `commit`) — and re-landed the same day reading `commit`, with tests using the real event shape and the payload omitting `mainCheck` entirely before any check.

### Time and spend by outcome in the failure digest (planned 2026-09-29, done 2026-09-29)

**Goal.** The failure digest (src/failure-report.ts `renderFailureMarkdown`) counts ticks by outcome per role. A 200 ms error and a 30-minute timeout therefore weigh the same, and nothing ranks agent-hours or dollars lost by cause. `tick_end` carries no duration (src/loop.ts, the `tick_end` `logEvent`). Only `tumwater history` pairs it with `tick_start`, and it never sums the result. The 2026-09-22 timeout episode (97 ticks, ~55 agent-hours discarded) read as 97 identical errors ([docs/commit-history-analysis.md](docs/commit-history-analysis.md)).

**Note 2026-09-29, feature run.** Landed with three deviations from the draft, none changing the acceptance criteria: (1) the shared tick-start pairing helper lives in src/events.ts (`tickStartMap`) rather than src/ui/history.ts — the codebase keeps collectors free of core→ui imports, and history.ts still switched to it; (2) the table's error-class bucket holds every non-landed, non-no_change result (review gate and merge-gate outcomes price in too), while the loss ranking clusters only `error`/`aborted`/`quiet_killed` as drafted — the other error-class results carry no message a cluster can own; (3) the byte-bound test moved 6 → 7 KB for the new section's worst case (one 3-cell row per configured role + 5 loss-cause lines). `report --failures --json` now prints the collector's `FailureReportData` — the old "clustered narrative with no agreed JSON shape" refusal is retired, since the digest now has a stable data shape.

### Yield-scaled clocks: a search role whose recent ticks land nothing ticks less often (planned 2026-09-29, done 2026-09-29)

**Goal.** Maintenance and search roles tick on a fixed clock plus the idle ladder. The idle ladder resets on any main move, so a role that keeps finding nothing keeps paying for it. From 2026-09-22 to 09-29, perf spent $1.17 on 41 no_change ticks against $0.48 on its 15 landings, and qa spent $0.38 on 23 no_change ticks for 2 landings ([docs/commit-history-analysis.md](docs/commit-history-analysis.md)). A role's own recent yield should stretch its interval, and one landing should restore it.

**Approach.**
- src/loop-state.ts `LoopState`: added `recentOutcomes?: string` — a ring of one-char codes, `L` for a landing (`changed`/`queued`) and `n` for a counted empty, last YIELD_RING=20 entries, maintained by `applyTickOutcome` (src/tick-outcome.ts). `error`/`aborted`/`quiet_killed` are not yield evidence and never enter the ring, so backend failures neither stretch nor reset a role's clock.
- A pure `yieldMultiplier(recent: string[]): number` (beside `nextBackoffSeconds`): 1 while any of the last 10 counted ticks landed, otherwise 2 at 10 empties, doubling per 5 further empties (15 → 4, 20 → 8), capped at 8. `isEligible` (src/scheduling.ts) multiplies the role's effective `minTickIntervalSeconds` gap by it — the gap check runs first, so the multiplication gates the "main moved" wake too, which is where the cost comes from.
- Applies to `DEFERRABLE_ROLES`, the observer roles (qa, telemetry), and bugfix (predicate `yieldScaledRole` in src/roles.ts). Deviation from the draft: bugfix scales regardless of whether BUGS.md has open bugs — isEligible does not read the backlog, and ten consecutive empty ticks are empty-yield evidence however many bugs are recorded; demand prioritization stays deferTick's job. Never feature, plan, or director; a pending inbox prompt or a fresh `wake` bypasses the gap entirely.
- Surface: `tumwater status` and `status --json` show `×N` beside the next-run time when the multiplier is above 1, so an operator can see why a role is quiet.

**Files touched:** src/loop-state.ts, src/tick-outcome.ts, src/roles.ts, src/scheduling.ts, src/ui/status-model.ts (the shared `yieldMultiplierFor`), src/ui/status-render.ts (the next-run cell — where the cell actually lives, not status-model as first drafted), src/ui/status-payload.ts (the `yieldMultiplier` JSON field), src/ui/gui-client.ts (the GUI's fmtNextRun twin), docs/how-it-works.md, and tests in test/tick-outcome.test.ts, test/scheduling.test.ts, test/status-render.test.ts, and test/gui.test.ts (the lockstep twin).

**Acceptance criteria.** Ten consecutive no_change ticks give a multiplier of 2, and it caps at 8. One `changed`/`queued` tick resets it to 1. Error-class results neither raise nor reset it. A role at ×4 with a 20 s gap does not tick on a main move within 80 s. `wake` and inbox prompts bypass it. feature, plan, and director are never scaled. `npm run test` passes.

**Note 2026-09-29, second run.** The first implementation was rejected in review for riding unclaimed work: its diff carried the dry role's test/orchestrator-3.e2e.test.ts refactor (then unlanded on main) and the objection about its dropped failure-path abort+drain. That refactor has since landed on main on its own (eb7b1235); this run re-implemented the plan on current main, so the diff contains only this plan's files — test/orchestrator-3.e2e.test.ts is untouched.

### Plan just in time: stop refining while plans wait, and anchor plans on symbols (planned 2026-09-29, done 2026-09-29)

**Goal.** 113 of plan's 193 commits all time, and 16 of 45 from 2026-09-22 to 09-29, re-audit or refine a waiting plan because landings moved its anchors ("re-audit … after 95 landings of drift"). The role prompt invites this ("if PLANS.md already has several unimplemented plans, prefer refining the weakest existing plan"). The plans also cite line numbers (`src/cli.ts, the doctor case (lines 132-140)`), which drift on nearly every landing, although feature greps for symbols anyway ([docs/commit-history-analysis.md](docs/commit-history-analysis.md)).

**Approach.**
- src/roles.ts `plan`: replace the "prefer refining the weakest existing plan" clause with: when PLANS.md `## Planned` already holds two or more plans without a Needs-review note, end with the nothing-to-do sentinel. Feature has work, and a waiting plan is refined by the feature run that picks it up, against the code as it is then. The Needs-review split rule stays first.
- src/role-guidance.ts `PLAN_SIZING` (shared with the director): anchor on file paths and symbol names (functions, types, constants, test names), never on line numbers or ranges, because line anchors go stale with every landing.
- src/roles.ts `feature`: one line saying that when a plan's anchors no longer match, correct the entry in the same change instead of refusing.
- Pin the new wording in test/prompt.test.ts.

**Files touched:** src/roles.ts, src/role-guidance.ts, test/prompt.test.ts. (Implementation: `NOTHING_TO_DO` is now imported into src/roles.ts from src/reply-contract.js so the plan prompt ends with the literal sentinel, and the plan-role test also pins that the "refining the weakest" clause is gone.)

**Acceptance criteria.** The plan prompt tells the role to stop at two or more waiting plans and no longer says "prefer refining the weakest". `PLAN_SIZING` forbids line-number anchors. The feature prompt allows in-place anchor correction. The prompt pins pass, and `npm run test` passes.

### Harness-attested suite counts: parse the gate check's `node --test` summary and hand it to the reviewer (planned 2026-09-29, done 2026-09-29)

**Goal.** The VERIFIED line of every commit body is model-written (src/prompt.ts `SUMMARY_BLOCK`, e.g. `"npm test, 182 pass"`), and the reviewer's checklist rejects a VERIFIED claim the diff disproves (src/gate-prompts.ts `buildReviewPrompt`). From 2026-09-22 to 09-29, 151 of 686 reviews were rejected, and roughly 113 of those reasons cite a record claim, most often a count or SHA ([docs/commit-history-analysis.md](docs/commit-history-analysis.md)). The harness already runs the suite at the gate. Today it keeps only green/red plus a failure tail, and even throws away the `ℹ pass N` lines (src/build-check-report.ts `FRAMING_LINE`). The harness should own the counts, so a model can no longer get them wrong.

**Approach.**
- src/build-check.ts: add `counts?: { tests: number; pass: number; fail: number; skipped: number }` to `BuildCheckOutcome`. Fill it from the combined stdout/stderr on both passed and failed outcomes with a pure `parseTestCounts(output): counts | undefined` that matches node's `ℹ tests N`, `ℹ pass N`, `ℹ fail N`, and `ℹ skipped N` summary lines (the last block wins). A project whose check prints no such block gets `undefined`, and nothing else changes.
- src/build-check-events.ts `buildCheckEvent`: include `counts` when present, so `build_check` events record it.
- src/review.ts, where `verifiedByHarness` is set: append the counts, e.g. `` `npm test` (the project's declared check) passed — 2065 pass, 0 fail, 1 skipped of 2066 ``.
- src/gate-prompts.ts checklist item 2: the reviewer checks that the claimed *commands* and observations match the diff. Counts are harness-attested and appear above. A count missing from VERIFIED is not a finding.
- src/prompt.ts `SUMMARY_BLOCK`: VERIFIED asks for what was run and observed beyond the suite total ("npm test; repro script showed X before, Y after"). Drop the `182 pass` example so authors stop restating counts. Update the prompt pins in test/prompt.test.ts.

**Files touched:** src/build-check.ts, src/build-check-events.ts, src/review.ts, src/gate-prompts.ts, src/prompt.ts, and tests in test/build-check.test.ts, test/review.test.ts, and test/prompt.test.ts.

**Acceptance criteria.** `parseTestCounts` reads the real runner's summary, including `skipped`, returns `undefined` for output with no summary, and takes the last block when several appear. A passing gate check's `build_check` event carries `counts`. The review prompt names the counts when the check passed. `SUMMARY_BLOCK` no longer shows a count example, and the review checklist says counts are harness-attested. `npm run test` passes.

- Bugfix defers like a maintenance role while BUGS.md has no open bugs (planned 2026-09-29, done 2026-09-29; commit 550f3bbd)
- A deterministic unused-export check in the suite (planned 2026-09-29, done 2026-09-29; commit 9a66e789)
- Cancel a queued prompt from the dashboard — the GUI's queued-prompts rows get a per-row cancel control, backed by a file-addressed `/api/prompt-cancel` (planned 2026-09-29, done 2026-09-29; commit 0d23f313)
- `tumwater doctor --json` — the pre-flight report as machine-readable data, finishing the scriptable-surface series (planned 2026-09-28, done 2026-09-29; commit bfb37aaf)
- `tumwater backlog --json` — the project backlog as machine-readable data, completing the `--json` pattern (planned 2026-09-28, done 2026-09-28; commit 933d2bdf)
- `tumwater logs --json` — the event feed as machine-readable NDJSON, completing the `--json` pattern (planned 2026-09-28, done 2026-09-28; commit b87d724c)
- `tumwater history --json` — the per-tick history as machine-readable data, completing the `--json` pattern (planned 2026-09-28, done 2026-09-28; commit 4aba2051)
- `tumwater report --json` — the usage report as machine-readable data, beside `status --json` (planned 2026-09-28, done 2026-09-28; commit ad5dfce4)
- GUI history tab — the dashboard shows the per-tick history `tumwater history` prints (planned 2026-09-28, done 2026-09-28; commit 495525f6)
- `logs --grep <text>` — show only the events whose type or rendered line matches (planned 2026-09-28, done 2026-09-28; commit 713835af)
- `report --since <duration>` — totals over a trailing window, not whole days (planned 2026-09-28, done 2026-09-28; commit 2060487d)
- `logs --since <duration>` — show the events of a time window, not a guess at a count (planned 2026-09-28, done 2026-09-28; commit e20948b4)

- Pause countdown — show when a timed pause auto-resumes (`status`/TUI header badge, GUI pause badge) (planned 2026-09-25, done 2026-09-28; commit 00cf2e98)
- `tumwater history [--role <id>] [-n N]` — one row per completed tick, newest first (planned 2026-09-28, done 2026-09-28; commit 5d0f978e)
- Timed pause — `tumwater pause [--role <id>] --for <duration>` auto-resumes (planned 2026-09-25, done 2026-09-28; commit 670fb0a1)

- Per-role prompts 2/2 — surface the per-role queue on the dashboards (planned 2026-09-25, done 2026-09-25; commit f91ed2b2)
- `tumwater run --once --role <id>` — one round scoped to a single role (planned 2026-09-25, done 2026-09-25; commit 758e6de1)
- Next-run visibility — show when each sleeping loop will tick again (`tumwater status`, TUI, GUI) (planned 2026-09-25, done 2026-09-25; commit ce24d771)
- Per-role prompts 1/2 — `tumwater prompt --role <id> <text...>`: steer one loop directly from the terminal (planned 2026-09-25, done 2026-09-25; commit 761af2b7)
- `tumwater run --once` — one full round of ticks (every enabled role once, landings drained), then exit (planned 2026-09-25, done 2026-09-25; commit 52cbadd1)
- `tumwater backlog` — read the project's planned features, open bugs, and open questions from the terminal (planned 2026-09-25, done 2026-09-25; commit 3251fd9a)
- TUI per-loop controls — pause/resume, abort, and wake the loop whose transcript you are viewing (planned 2026-09-25, done 2026-09-25; commit 84e17230)
- Per-role pause 2/2 — dashboard per-row pause toggle (planned 2026-09-25, done 2026-09-25; commit 568b7cc8)
- Per-role pause 1/2 — `tumwater pause --role <id>` / `resume --role <id>`: quiet one loop while the fleet keeps working (planned 2026-09-25, done 2026-09-25; commit 88903ade)
- `tumwater config` — print the effective merged config as JSON (planned 2026-09-25, done 2026-09-25; commit 4fa76fca)
- `tumwater stop` — stop a running fleet from another terminal (planned 2026-09-24, done 2026-09-25; commit 69568f58)
- Land-queue speed 2c — Split landing into a parallel vetting stage and a serial merge stage (planned 2026-09-23, done 2026-09-24; commit 84af95b)
- Land-queue speed 1/3 — Take the build-fix run out of the landing slot: retry a failed gate check once, then hand the failure to whoever caused it (planned 2026-09-23, done 2026-09-24; commits 4e9bf7f, 91ef22a)
- Land-queue speed 2a — Approvals survive a clean rebase: key them by patch-id, not sha (planned 2026-09-23, done 2026-09-24; commit 689a293)
- Land-queue speed 3c — One writer to main: route leftover recovery through the land queue (planned 2026-09-23, done 2026-09-24; commit 3206c2e)
- Land-queue speed 3d — When a batch check is red, land the largest passing prefix (planned 2026-09-23, done 2026-09-24; commit c35f78c)
- Land-queue speed 2b — One process-wide cap on concurrent build checks: `maxConcurrentChecks` (planned 2026-09-23, done 2026-09-24; commit 16e25b1)
- Land-queue speed 3e — Optional cheaper per-change gate check; the full suite runs once per stack (planned 2026-09-23, done 2026-09-24; commit 46c0bde)
- Land-queue speed 3a — Give the reviewer its own time budget (planned 2026-09-23, done 2026-09-24; commit 376547d)
- 7b/7 — `tumwater init --adopt` and `--dry-run`: adopt an existing repo without touching its README (planned 2026-09-23, done 2026-09-24; commit 063d9b4)
- Give every failure an automated trace: retire the recurring `no-observability` validation gap (planned 2026-09-26, done 2026-09-24; commit 199ed60)
- Land-queue speed 2d — Per-change landing markers so the dashboards show what is really happening (planned 2026-09-23, done 2026-09-24; commits 127157a, 95f848c)
- Land-queue speed 3b — Tell the reviewer, as a rule, not to re-run a verified suite (planned 2026-09-23, done 2026-09-24; commit 07d205e)
- 7a/7 — Resolve the project brief as `TUMWATER.md`, with README.md as the compatibility path (planned 2026-09-23, done 2026-09-23; commit 3be47ac)
- Wake and abort from the GUI dashboard (planned 2026-09-25, done 2026-09-23; commit d947041)
- 6/7 — Make the project's verification command configurable (planned 2026-09-14, done 2026-09-25; commit 4924a54)
- Optional shared-token auth for the GUI dashboard — `gui --token <secret>` (planned 2026-09-23, done 2026-09-23; commit 66c5af0)
- Cost by role in the usage report (planned 2026-09-25, done 2026-09-23; commit 6e1bf39)
- Bound tool output head+tail with a tumwater pi extension (planned 2026-09-23, done 2026-09-24; commit d964507)
- Tell ticks to fan out independent tool calls in one turn (planned 2026-09-23, done 2026-09-23; commit 449985c)
- 5/7 — Make the agent binary configurable (planned 2026-09-14, done 2026-09-24; commit ff4beee)
- 4b/7 — Untrack this repo's own config without deleting it (planned 2026-09-14, done 2026-09-22; commit 48b3474)
- 4a/7 — Seed an untracked config from a tracked template (planned 2026-09-14, done 2026-09-22; commit 0733811)
- 3/7 — Harness-mediated config writes: take custom loops off the commit path (planned 2026-09-14, done 2026-09-23; commit 726e3cc)
- 2/7 — Resolve the repo root, and target any branch (planned 2026-09-14, done 2026-09-22; commit c033ad1)
- Fix a failed landing build check on the spot instead of rejecting (planned 2026-09-21, done 2026-09-23; commit 4803c07)
- Landing gate checks latest main: rebase the pinned change before the build pre-check (planned 2026-09-21, done 2026-09-21; commit f0993fc)
- 1/7 — GitHub Actions CI and a publishable npm package (planned 2026-09-14, done 2026-09-21; commit e6a4228)

- 4c/7 — Move README's rig notes into docs/backends.md (planned 2026-09-14, done 2026-09-21; commit dfa6d26)
- TUI failures pane — the failure digest in the Ctrl+T cycle (planned 2026-09-20, done 2026-09-21; commit c92c549)
- Fleet pause from the dashboard — a click-to-pause control in the GUI header (planned 2026-09-20, done 2026-09-21; commit f265dd7)

- Human-friendly numbers in the report tab's chart labels (planned 2026-09-20, done 2026-09-21; commit 6926014)
- Failure digest in the GUI — a `failures` tab beside `report` (planned 2026-09-19, done 2026-09-19; commit d4d734e)
- Live config-change event — surface what a tumwater.json edit changed (planned 2026-09-19, done 2026-09-19; commit 1767778)
- Red-main handoff — point the bugfix loop at the failing suite when main is red (planned 2026-09-19, done 2026-09-19; commit cfac056)
- Repair traces — record what made each bug hard to validate (planned 2026-09-17, done 2026-09-19; commit 794e170)
- Show the exact prompt each run received — `tumwater logs --role <id> --prompt` (planned 2026-09-19, done 2026-09-19; commit 30f3124)
- Observer roles 2/2 — a flow-coverage ledger so `qa` can rotate (planned 2026-09-17, done 2026-09-19; commit 492cbeb)
- Feature loop hands oversized plans to the plan loop instead of splitting them inline (planned 2026-09-18, done 2026-09-19; commit ac97ec6)
- Telemetry 2/2 — a `telemetry` role that reads the digest and files bugs (planned 2026-09-17, done 2026-09-19; commit 24ded35)
- Telemetry 1/2 — a deterministic failure digest over the fleet's own event log (planned 2026-09-17, done 2026-09-18; commit 39dfc33)
- Observer roles 1/2 — stop scheduling a passing check as an idle tick (planned 2026-09-17, done 2026-09-18; commit c1ad951)
- TUI/GUI auto-reload when a newer build lands on disk (planned 2026-09-13, done 2026-09-18; commit 614ff78)
- Merge queue 5/5 — coalesce the build check across queued landings (planned 2026-09-08, done 2026-09-18; commit 8a3e6a1)
- Fallback model — keep working for free once the daily budget is spent (planned 2026-09-18, done 2026-09-18; commit 7ab1275)
- Merge queue 4/5 — surface the land queue on status and both dashboards (planned 2026-09-08, done 2026-09-15; commit 776fa0f)

- GUI report charts: show a label on each bar segment at the cursor on mouse hover (planned 2026-09-14, done 2026-09-15; commit b56c96f)
- Merge queue 3/5 — asynchronous landing via a durable land queue (planned 2026-09-08, done 2026-09-14; commit bdec4f1)
- Remove the per-loop tokens/sec column from the TUI/GUI tables (planned 2026-09-14, done 2026-09-14; commit b5180be)
- Merge queue 2/5 — land in a per-role detached worktree (planned 2026-09-08, done 2026-09-13; commit a90a1ac)

- Show per-loop token generation rate (5-minute moving average) in the TUI/GUI (planned 2026-09-08, done 2026-09-13; commit 8477f9b)
- User-defined loops 3/3 — dashboard identification: mark user-defined loops on both surfaces (planned 2026-09-07, done 2026-09-13; commit 332e072)
- User-defined loops 2/3 — director control surface: add/remove/rearrange from the prompt box (planned 2026-09-07, done 2026-09-12; commit 0b1db0a)
- User-defined loops 1/3 — config plumbing: `customLoops` in tumwater.json (planned 2026-09-07, done 2026-09-12; commit 7aaa69a)
- Show the GUI loop table's last tick with relative age — match the TUI's "· Nm ago" (planned 2026-09-11, done 2026-09-12; commit 8865aa8)
- Make the daily cost budget editable from the TUI/GUI (planned 2026-09-07, done 2026-09-12; commit e8bdd24)
- Sort the GUI loop table by state category, then last tick (planned 2026-09-09, done 2026-09-11; commit fafebbe)
- TUI "usage report" pane in the Ctrl+T cycle — report 3/3 (planned 2026-09-10, done 2026-09-11; commit dd32fc5)
- GUI "report" tab with SVG dashboard — report 2/3 (planned 2026-09-10, done 2026-09-10; commit 465f1f6)
- Usage report core + `tumwater report` CLI subcommand — report 1/3 (planned 2026-09-10, done 2026-09-10; commit 542e49a)
- Prioritize loops by need — defer unneeded maintenance ticks and order work roles first (planned 2026-09-08, done 2026-09-10; commits 1406be5, b2ddeb6)
- Merge queue 1/5 — landing takes a worktree and a ref (planned 2026-09-08, done 2026-09-08; commit 8665dca)
- Label review-gate runs in loop transcripts (planned 2026-09-07, done 2026-09-08; commit 7730bb1)
- Read backlog entries in full from the TUI/GUI dashboards (planned 2026-09-05, done 2026-09-07; commits 2c85ea4, 1a5fff9)
- Fleet pause — `tumwater pause` / `tumwater resume` (planned 2026-09-05, done 2026-09-06; commits 9481eeb, 7c56ca1, b76fab1)
- Pre-flight environment check — `tumwater doctor` (planned 2026-09-05, done 2026-09-06; commits 784d487, be36b71)
- Machine-readable fleet state — `tumwater status --json` (planned 2026-09-05, done 2026-09-05; commit e46b811)
- Red-main baseline check — skip authoring runs while main is red (planned 2026-09-04, done 2026-09-05; commits 377cf0f, e7ef65c)
- Steward curation of BUGS.md's Fixed history — compress old fixed bugs to one-line records (planned 2026-09-04, done 2026-09-05; commit 24f39e2)
- Steward curation of PLANS.md's Done history — compress old done plans to one-line epitaphs (planned 2026-09-04, done 2026-09-04; commit 81c50a2)
- Section-aware tick reads — stop paying for history every tick (planned 2026-09-04, done 2026-09-04; commit 7516413)

- Bound README's status section — state, not log (planned 2026-09-03, done 2026-09-04; commit 9e00d29)
- Run the project's own test suite in the deterministic pre-merge gate (planned 2026-09-04, done 2026-09-04; commit 495570f)
- Abort a single loop's in-flight tick — `tumwater abort --role <id>` (planned 2026-09-03, done 2026-09-04; commits b37e600, 6b52731, 0d4c41b, 7a9fa8d, ff42635)
- Per-loop today spend — which loop is eating the day's budget (planned 2026-09-02, done 2026-09-03; commits c17893d, 02a8661)
- Steward role — whole-system judgment on a slow clock (planned 2026-08-24, done 2026-09-02; commits 6e3f487, be6dc56, bf42c98)
- Per-tick usage in the event feed — tokens and cost on every tick_end (planned 2026-09-02, done 2026-09-02; commit 3e4086a)
- Director inbox management — list and cancel queued prompts (planned 2026-09-01, done 2026-09-02; commits 53c0477, 349482e, 9c20312, da86dbd)
- Live sessionRetentionDays — re-prune old pi sessions without a restart (planned 2026-08-31, done 2026-09-02; commits eaa9848, 349482e, 157215f)
- Show queued director prompts in TUI/GUI (planned 2026-09-01, done 2026-09-01; commit 55af189)
- Live maxConcurrent — resize the concurrency cap without a restart (planned 2026-08-31, done 2026-09-01; commit af61b7e)
- Self-explaining commit bodies (planned 2026-08-24, done 2026-08-31; commits b41185d, 0f73491, d930959, 4021c1d)
- Daily cost budget — cap the fleet's autonomous spend (planned 2026-08-30, done 2026-08-31; commits 041fd55, 01c28ce, 07d5bf6, 2fbfb49, 92a4ffe, b589e09)
- The right to refuse, and friction as a signal (planned 2026-08-24, done 2026-08-30; commits c2f541a, 0326a2a, 82c7631, bc479b6, c477ce9, 7212a7e, 8e6eeae)
- Questions outbox — loops that know when to ask (planned 2026-08-24, done 2026-08-29; commits 2547b4d, 0294f45, 1a48edc, 931ca26)
- Adversarial review gate before merge (planned 2026-08-24, done 2026-08-29; commits 74224e9, 8ea49b8, 93d14f5, 038519a, 36b0adc, 50ef9eb)
- QA role — exercising the product like a user (planned 2026-08-24, done 2026-08-28; commit 6859e43)
- Show timestamp of last result in the GUI/TUI live table (planned 2026-08-21, done 2026-08-26; commit 9ef07d9)
- PRINCIPLES.md — positive design principles injected into every prompt (planned 2026-08-24, done 2026-08-26; commit abd2963)
- Show open bugs and planned features in the TUI/GUI (planned 2026-08-24, done 2026-08-26; commit 7023381)
- Show current work item per active loop in the GUI/TUI tables (planned 2026-08-25, done 2026-08-25; commit 39bfe9d)
- CLI subcommand to reset loop counters — ticks, commits, tokens, cost (planned 2026-08-25, done 2026-08-25; commit 5374aa5)
- Live-reload tumwater.json while the harness is running (planned 2026-08-23, done 2026-08-25; commit 82c7910)
- Linear history on main: rebase instead of merge commits (planned 2026-08-24, done 2026-08-25; commit 52fcfa2)
- Surface per-role pi transcripts in the TUI/GUI (planned 2026-08-23, done 2026-08-24; commit d36cb17)
- Per-role pi transcript via `tumwater logs --role` (planned 2026-08-21, done 2026-08-23; commit 48f45a1)
- Totals row for tokens and cost in the status table (planned 2026-08-21, done 2026-08-21; commit 9ddd731)
- Decompose requests into sub-plans/sub-bugs when routing (planned 2026-08-21, done 2026-08-21; commit 3e002c9)
- Web GUI (done 2026-08-20; commit 2182085)
- pi-driven merge conflict resolution (done 2026-08-20; commit 2182085)
- Per-role model/effort overrides (done 2026-08-20; commit 2182085)
- Log rotation and session pruning (done 2026-08-20; commit 2182085)
