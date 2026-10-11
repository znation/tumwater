# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.


## Planned

### List every loop's queued prompts in a TUI Queued pane, matching `tumwater prompt --list` (planned 2026-10-11 by plan; sibling of the landed TUI Pending pane (`tumwater queue`), the landed dashboard Queued tab (`prompt --cancel`), and the waiting dashboard queued-prompt edit series (parts 1/2 and 2/2); completes `tumwater prompt --list`'s read surface on the TUI, which today shows only the director's numbered previews above every pane (`tui.tsx`'s `snap.inboxPrompts`) and each role's `p:N` count marker (`status-render.ts`'s `roleQueued`), never the role queues' contents or a deferred prompt's countdown; read-only, so it needs no server, mutation, or cancellation; independent of the waiting TUI History grep plan in behavior — it touches `tui-keys.ts`/`tui-frame.ts`/`tui.tsx` too, but its own Queued branch rather than the History branches, so a landing conflict is possible and the resolver handles it; it shares `src/inbox/inbox.ts` with the waiting dashboard queued-edit part 1/2 only at the read seam, which edits `inbox-edit.ts`)

**Goal.** `tumwater prompt --list` prints every queued prompt grouped by loop (director first, then
catalog order), each numbered from 1 with its full text and a `(queued <age> ago)` suffix — or a
`(delivers in <duration>)` countdown when the prompt carries a not-before marker — while
`tumwater prompt --cancel <n>` consumes that same per-loop numbering. The TUI has no pane showing
that list. Add a Queued pane after Pending that renders the CLI's list from the CLI's own row
builder, so the two surfaces cannot drift on order, numbering, or the age/countdown wording.

**Approach.**
1. `src/inbox/inbox.ts`: move the list-shaping pieces out of `prompt-commands.ts` so the CLI and
the TUI read one queue list (import `knownRoleIdsCached` from `../config/config.js` — config
imports no inbox module, so no cycle — and `humanSeconds`/`secondsSince`/`secondsUntil` from
`../text/datetime.js`):
   - `export function listWideScope(root: string): string[]` — the moved one-liner
     `[DIRECTOR_ROLE, ...knownRoleIdsCached(root).filter((r) => r !== DIRECTOR_ROLE)]`.
   - `export interface QueuedListRow { role: string; position: number; text: string; queuedAtMs: number | null; notBeforeMs: number | null }`.
   - `export function queuedListRows(root: string, role: string | null, validIds: string[]): QueuedListRow[]` —
     the moved `promptListPayload` body (director records first when `role` is null, then
     `validIds`), stripping the marker from each text through `stripNotBeforeMarker` exactly as
     today.
   - `export function queuedAgeSuffix(queuedAtMs: number | null, notBeforeMs: number | null, now: number): string` —
     moved verbatim from `prompt-commands.ts`, doc comment kept.
   - `export function renderQueuedList(rows: readonly QueuedListRow[], now: number): string` —
     the moved section loop: group consecutive rows by role, one `<role>:` section per loop
     holding `"<position>. <text><queuedAgeSuffix>"` lines, sections joined by `\n`; the CLI's
     `say(sections.join("\n"))` output is byte-identical.
   Keep each moved doc comment, retargeting “the CLI's --list” to name both surfaces.
2. `src/inbox/prompt-commands.ts`: delete the moved locals (`promptListPayload`,
`queuedAgeSuffix`, `listWideScope`) and the now-unused `humanSeconds`/`secondsSince`/
`secondsUntil`/`knownRoleIdsCached` imports; import `listWideScope`, `queuedListRows`,
`renderQueuedList` from `./inbox.js`. The `--json` arm keeps
`sayJson({ prompts: queuedListRows(root, role, validIds as string[]) })`; the prose arm keeps its
`prompts.length === 0` guard, then `say(renderQueuedList(prompts, Date.now()))`.
3. `src/ui/tui/tui-frame.ts`: `TuiView` gains `| { kind: "queued" }`; `tabStrip`'s `tabs` gains
`["queued", "Queued"]` after `["pending", "Pending"]`; `hintLine` gains a `queued` branch with
the pending branch's keys (`Enter`/`↑↓`/`PgUp PgDn`/`Ctrl+T`/`Ctrl+D`).
4. `src/ui/tui/tui-keys.ts`: import `listWideScope`, `queuedListRows`, `renderQueuedList` from
`../../inbox/inbox.js`; in the Ctrl+T handler change the cycle to
`(view + 1) % (roleIds.length + 7)` and add, beside the Pending branch inside
`if (!refreshPaneCache("all"))`, `else if (view === roleIds.length + 6) paneCache =
renderQueuedList(queuedListRows(root, null, listWideScope(root)), now());` (the factory's
injected `now` clock, so a test pins the suffix); the `syncSnapshot` clamp becomes
`Math.min(view, roleIds.length + 6)`; update the `view` comments.
5. `src/ui/tui/tui.tsx`: the pane selection gains
`: view === roleIds.length + 6 ? { kind: "queued" }` before the activity fallback.
6. `src/ui/tui/tui-pane.ts`: add a `queued` branch returning `paneCache` windowed through
`entryBodyWindow` exactly like the `history`/`pending` branches, with
`emptyNote: "(no queued prompts)"`; extend the `paneBody` doc's kind list.
7. `docs/how-it-works.md`: the TUI bullet lists the Queued pane after Pending and names
`tumwater prompt --list` as the CLI view it matches.

**Files touched.** `src/inbox/inbox.ts`, `src/inbox/prompt-commands.ts`,
`src/ui/tui/tui-frame.ts`, `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui.tsx`,
`src/ui/tui/tui-pane.ts`, `docs/how-it-works.md`, `test/tui-frame.test.ts`,
`test/tui-keys.test.ts`, `test/tui.test.ts`.

**Acceptance criteria.**
- `test/prompt-commands.test.ts`: the existing `prompt --list` prose and `--json` cases stay green
  against the extracted `queuedListRows`/`renderQueuedList` (same sections, numbering, and
  suffix). A new case seeds one director prompt and two role prompts and asserts
  `renderQueuedList(queuedListRows(root, null, listWideScope(root)), now)` yields the director
  section first then the role's, each numbered from 1, and a deferred prompt's line carries
  `(delivers in ` from its future `notBeforeMs` rather than an age.
- `test/tui-keys.test.ts`: the cycle case now sees Pending at `roleIds.length + 5`, a further
  Ctrl+T lands on Queued at `roleIds.length + 6`, and the next wraps to Activity; with a director
  and a role queue file seeded, entering Queued sets `state().paneCache` to
  `renderQueuedList(queuedListRows(root, null, listWideScope(root)), <fixed now>)`; leaving Queued
  drops it to null.
- `test/tui-frame.test.ts`: every `tabStrip` expectation gains `Queued` after `Pending` (including
  the narrow-width case staying within its width), a `hintLine({ kind: "queued" }, …)` case
  matches its keys, and the Ctrl+D loop includes `{ kind: "queued" }`.
- `test/tui.test.ts`: a `paneBody({ kind: "queued" }, …)` case windows the cached list and returns
  the `(no queued prompts)` note when the cache is null.
- `docs/how-it-works.md` names the Queued pane and `tumwater prompt --list`.
- `npm run test` is green.

### Edit a queued prompt from the dashboard Queued tab (planned 2026-10-11 by plan; part 2/2 of "Edit a queued prompt from the dashboard Queued tab" — the browser affordance over part 1/2's `GET /api/prompt-text` and `POST /api/prompt-edit`, requires part 1/2 landed; independent of the waiting TUI Pending land-queue, TUI History grep, and dashboard Settings Clear plans — GUI client only, no `src/ui/tui`, `src/inbox`, or `src/gui` file)

**Goal.** The dashboard's Queued tab lists every queued prompt with a Cancel button, but
correcting a typo means cancel and re-queue; `tumwater prompt --edit` has no browser surface even
though part 1/2 serves the body and the write. Add an inline editor: an Edit button per queued
row loads the prompt's body into a textarea in place, and Save replaces it through
`/api/prompt-edit`.

**Approach.**
1. `src/ui/gui/gui-client-fleet.ts`, the `backlog` region:
   - Add state beside `backlogTab`: `let backlogStatus = null` (the payload the edit helpers
     repaint from), `let queuedEdit = null` (`{ role, file, text } | null`), and
     `let queuedEditPainted = false`.
   - `renderBacklog(d)`: set `backlogStatus = d` first; then
     `if (queuedEdit && queuedEditPainted) return;` so the standing 1s poll cannot repaint over
     the textarea the operator is typing in.
   - The queued row map: each item gets, after the Cancel button,
     `<button type='button' class='btn btn-sm rowaction' data-action='promptedit' data-file='…'
     data-role='…'>Edit</button>`; when the item matches `queuedEdit`
     (`q.file === queuedEdit.file && q.role === queuedEdit.role`), render instead a
     `<div class='list-item'>` holding `<textarea id='queuedit' class='…'>` + `esc(queuedEdit.text)`
     + `</textarea>` and Save/Cancel buttons (`data-action='prompteditsave'`/`'prompteditcancel'`,
     each carrying the same `data-file`/`data-role`). Set `queuedEditPainted = true` before
     `paintPanel` when the editor was rendered.
   - Add `function beginQueuedEdit(role, file, text)`: `backlogTab = "queued";
     queuedEdit = { role, file, text }; queuedEditPainted = false; renderBacklog(backlogStatus)`.
   - Add `function endQueuedEdit()`: `queuedEdit = null; queuedEditPainted = false;
     renderBacklog(backlogStatus)`.
   - `setBacklogTab(tab)`: before `renderBacklog(lastStatus)`, clear `queuedEdit` and
     `queuedEditPainted`, so switching tabs abandons an open editor.
2. The delegated `$("backlog")` click handler (below the region) gains three arms before the
   `.backloglink` arm: `button.rowaction[data-action='promptedit']` →
   `await getJson("/api/prompt-text?role=" + encodeURIComponent(role) + "&file=" +
   encodeURIComponent(file))`; a `{ status: "gone" }` answer flashes `"No longer queued — …
   already took it"` and refreshes, otherwise `beginQueuedEdit(role, file, d.text || "")`; a thrown
   fetch flashes the `error:` pattern. `[data-action='prompteditsave']` → read `$("queuedit")`'s
   trimmed `value` (flash and stop when empty), `await postAction("/api/prompt-edit", { role,
   file, text }, …)` with the `edited`/`gone` flash wording the cancel arm uses, then
   `endQueuedEdit()`. `[data-action='prompteditcancel']` → `endQueuedEdit()`. `$` and `getJson` are
   already in scope; `endQueuedEdit`/`beginQueuedEdit` are hoisted from the region.
3. `docs/how-it-works.md`: the Operator notes sentence naming the Queued tab adds that each
   queued prompt can be edited in place (Edit loads its body, Save replaces it through the same
   path `tumwater prompt --edit` uses), beside the existing age sentence.

**Files touched.** `src/ui/gui/gui-client-fleet.ts`, `test/gui-client-fleet.test.ts`,
`docs/how-it-works.md`.

**Acceptance criteria.**
- `test/gui-client-fleet.test.ts`: the queued rows now emit one `data-action='promptedit'` Edit
  button per prompt beside the cancel buttons, with the queue-file address and role (the existing
  cancel assertions stay green). `beginQueuedEdit("qa", "q.md", "new body")` paints the queued tab
  with a `<textarea id='queuedit'>` holding `new body` and Save/Cancel buttons carrying
  `data-file='q.md'`/`data-role='qa'`, and a following `renderBacklog(status)` writes no second
  paint (the poll cannot clobber the editor). `endQueuedEdit()` repaints the plain list (no
  textarea, Edit and Cancel buttons back). `setBacklogTab` while editing discards the editor and
  paints the newly selected tab.
- A string assertion on `GUI_CLIENT_FLEET_JS` pins the delegated handler's edit arms: the
  `promptedit`, `prompteditsave`, and `prompteditcancel` selectors, the `/api/prompt-text?role=`
  fetch, and the `/api/prompt-edit` post.
- `docs/how-it-works.md` describes the Queued tab's Edit action and names `tumwater prompt --edit`
  as the path it shares.
- `npm run test` is green.

### Defer a prompt from the dashboard composer, matching `tumwater prompt --at <duration>` (planned 2026-10-11 by plan; sibling of the landed CLI `tumwater prompt --at <duration>` (commit 654f15b3) and the landed dashboard deferral display (`gui-client-fleet.ts`'s `delivers in`); the dashboard can already paint a deferred prompt's countdown but no dashboard surface can set the marker, so an operator must drop to the CLI to schedule one; independent of the waiting TUI Queued pane, TUI History grep, dashboard queued-prompt edit, and dashboard Settings Clear plans in code — `src/cli/cli-args.ts`'s newly exported `parseDurationMs` plus `src/inbox/inbox-submit.ts`, the two prompt handlers in `src/gui/gui-endpoint-commands.ts`, and the composer files, no `src/ui/tui` file — it shares `src/gui/gui-endpoint-commands.ts` with the landed prompt-edit and Settings Clear handlers but edits different functions, so a landing conflict is possible and the resolver handles it)

**Goal.** `tumwater prompt --at <duration>` queues a prompt whose `tumwater:not-before <iso>`
marker line (`src/inbox/prompt-not-before.ts`'s `notBeforeMarker`) keeps it out of execution
order until the duration passes; the marker rides through the one `enqueueRolePrompt` atomic
write and every display surface strips it (`stripNotBeforeMarker`). The dashboard's
`/api/prompt` and `/api/prompt-role` never set it and the composer has no control for it, so a
deferred prompt can be shown (`gui-client-fleet.ts`'s `delivers in …`) but not created from the
browser. Add an optional defer field to the composer and thread the parsed delay to the same
submit path the CLI uses, so the two surfaces cannot disagree on the grammar or the marker.

**Approach.**
1. `src/cli/cli-args.ts`: add `export` to the existing private `parseDurationMs` (leave
`UNIT_MS`/`UNIT_ORDER` private), keeping its doc comment and body unchanged. `parseDurationFlag`
and `durationLabel` are untouched (same definitions, same `fail()` wording), so every existing
importer and `test/cli-args.test.ts`'s duration cases stay green. Exporting the grammar's own
parser gives the server a function that returns `null` instead of ending the process through
`parseDurationFlag`'s `fail()` wrapper, and there is still one copy of the grammar.
`src/operator/operator-intent.ts` and `src/inbox/prompt-commands.ts` already import
`durationLabel` from this module, so the import edge exists; the new caller is only one more.
2. `src/inbox/inbox-submit.ts`: `submitPrompt` gains the `notBeforeMs?: number` parameter its
role sibling `submitRolePrompt` already has and forwards it (`submitRolePrompt(root,
DIRECTOR_ROLE, text, images, notBeforeMs)`).
3. `src/gui/gui-endpoint-commands.ts`:
   - Extend `checkedPromptFields` to read an optional `defer` field before it returns: absent →
no deferral; a non-string, blank, or `parseDurationMs`-null value (imported from
`../cli/cli-args.js`) → 400 `{ error: "defer needs a duration like 45s, 90m, 1h30m, or 2d" }`
and return null; a parsed value over
`PAUSE_FOR_MAX_MS` (imported from `../operator/operator-intent.js`, the same 90d cap the CLI's
`failOverDurationCap` applies) → 400 `defer is capped at 90d`. Return `{ text, images,
notBeforeMs }` with `notBeforeMs = Date.now() + ms` when a defer was given, `undefined`
otherwise.
   - `handlePrompt` passes `fields.notBeforeMs` to `submitPrompt`; `handlePromptRole` passes it
to `submitRolePromptAndWake` (which already accepts it).
4. `src/ui/gui/gui-page.ts`: the composer's `composer-foot` gains a labelled compact input
`<input class="field" id="promptdefer" type="text" placeholder="defer (45m)"
autocomplete="off">` (its `<label>` carries `sr-only` text) beside `prompthint`.
5. `src/ui/gui/gui-client-composer.ts`:
   - `sendPrompt(target, text, images, defer)` adds a `defer` key to the POST body only when
the trimmed value is non-empty, and appends ` — delivers in <defer>` to the confirmation for a
deferred prompt (echoing the operator's own spelling, like the CLI's `durationLabel` echo).
   - The submit handler reads `$("promptdefer").value.trim()`, passes it, and clears the input
only after a successful send (kept on a refusal, like the text and the images). Whitespace-only
text is still the no-op it is today.
6. `docs/how-it-works.md`: the dashboard Fleet bullet's prompt-box sentence adds that the
composer can defer a prompt by a duration, using the same grammar and `tumwater:not-before`
marker `tumwater prompt --at` uses.

**Files touched.** `src/cli/cli-args.ts`, `src/inbox/inbox-submit.ts`,
`src/gui/gui-endpoint-commands.ts`, `src/ui/gui/gui-page.ts`,
`src/ui/gui/gui-client-composer.ts`, `test/gui-operator.test.ts`,
`test/gui-client-composer.test.ts`, `docs/how-it-works.md`.

**Acceptance criteria.**
- `test/gui-operator.test.ts`, new cases beside the `/api/prompt-role` case: a live-server
`POST /api/prompt` with `{ text, defer: "90m" }` answers 200 and the director queue's newest
prompt record (`queuedRolePromptEntries(root, DIRECTOR_ROLE)` or a raw read of
`.tumwater/inbox/<stamp>.md`) carries a `notBeforeMs` in the future, roughly now + 90m; a
`POST /api/prompt-role` with `{ role: "feature", text, defer: "1h30m" }` does the same for that
role's queue and still returns the wake message. `defer: "soon"`, `defer: "30m1h"`, and
`defer: 30` answer 400 matching `/duration like 45s, 90m, 1h30m, or 2d/` and queue no file;
`defer: "91d"` answers 400 matching `/capped at 90d/`; an absent `defer` queues the same
marker-less prompt as today (the existing cases stay green, and
`src/inbox/prompt-not-before.ts`'s `notBeforeMs()` reads `null` for it).
- `test/gui-client-composer.test.ts`: the submit test sets `promptdefer` and asserts both POST
bodies (`/api/prompt` and `/api/prompt-role`) carry the `defer` key unchanged, the flash names
`delivers in`, and the field clears on success but survives a rejected send; a string assertion
on `GUI_CLIENT_COMPOSER_JS` pins the `promptdefer` read and the `defer` key; the fake-DOM helper
gains the `promptdefer` element so the existing composer cases keep running.
- `test/cli-args.test.ts`'s `parseDurationFlag`/`durationLabel` cases stay green unchanged,
pinning the export as behavior-preserving.
- `docs/how-it-works.md` names the composer's defer control and the `tumwater prompt --at`
grammar it shares.
- `npm run test` is green.

## Done

### Read and edit a queued prompt by its queue file behind the dashboard API (planned 2026-10-11 by plan; part 1/2 of "Edit a queued prompt from the dashboard Queued tab" — the server seam and endpoints its client half consumes; sibling part 2/2 requires this landed; the file-addressed twin of the landed CLI `tumwater prompt --edit` and the landed file-addressed `POST /api/prompt-cancel`; independent of the waiting TUI Pending land-queue, TUI History grep, and dashboard Settings Clear plans in code — inbox/gui only, no `src/ui/tui` or `src/ui/gui` file — though it shares `src/gui/gui-endpoint-commands.ts` and `src/gui/gui-server.ts` with the Settings Clear plan, so a landing conflict is possible and the resolver handles it; done 2026-10-11 by feature)

**Goal.** `tumwater prompt --edit <n>` rewrites a queued prompt's text in place and carries its
attachments, and the dashboard's Queued tab can cancel a prompt, but the browser has no way to
edit one: `/api/prompt-cancel` addresses a prompt by its queue file while `editRolePrompt`
addresses it by list position, and no endpoint exposes the queued body. Add a file-addressed
read and edit to the API — `GET /api/prompt-text` returns a prompt's editable body and `POST
/api/prompt-edit` replaces it through the same `editRolePrompt` machinery the CLI uses.

**Approach.**
1. `src/inbox/inbox-attachments.ts`: add `export function stripImageReferenceLines(text: string): string`
   beside `imageReferencePaths` — drop every line whose trimmed form matches the module's own
   `IMAGE_REF_LINE` and trim trailing blank lines, documented as the reader `imageReferenceLines`
   needs (the reference block is plumbing, never shown in an editor).
2. `src/inbox/inbox-edit.ts`:
   - Extract the body of `editRolePrompt` after it resolves `file` into a private
     `editPromptAtFile(root: string, role: string, file: string, newText: string, images?: PromptImageInput[]): EditOutcome`
     (unchanged behavior: trim, length check, read, gone-on-ENOENT, carried deferral, carried and
     appended image references, atomic write, `prompt_edited` event). `editRolePrompt` becomes
     `queuedFileAtPosition` → `editPromptAtFile`.
   - Add `export function editQueuedFile(root, role, name, newText, images?): EditOutcome` —
     `queueFileNameProblem(name)` (imported from `./inbox-cancel.js`) throws its message, then
     `editPromptAtFile(root, role, path.join(roleInboxDir(root, role), name), newText, images)`.
     Import `path` from `node:path` and `roleInboxDir` from `../paths.js`.
   - Add `export function readQueuedPromptBody(root, role, name): string | null` — the same name
     guard (throw), `readTextIfExists(path.join(roleInboxDir(root, role), name))`, `null` when the
     file is gone, else `stripImageReferenceLines(stripNotBeforeMarker(text)).trimEnd()`. Reading
     one file directly keeps the dashboard's lazy fetch off the per-poll path.
3. `src/gui/gui-endpoints.ts`: add `export function handlePromptText(q: URLSearchParams, res, root)`
   — `const roleParam = q.get("role")`; when it is non-null and `rejectBadRole(root, res, roleParam)`
   returns, stop; `role = roleParam ?? DIRECTOR_ROLE`; `queueFileNameProblem(q.get("file"))` → 400
   `{ error }`; `readQueuedPromptBody` → null `{ ok: true, status: "gone" }`, else
   `{ ok: true, text }`. Imports: `readQueuedPromptBody` from `../inbox/inbox-edit.js`,
   `queueFileNameProblem` from `../inbox/inbox-cancel.js`, `DIRECTOR_ROLE`, `rejectBadRole`. Update
   the module doc's endpoint list.
4. `src/gui/gui-endpoint-commands.ts`: add `export async function handlePromptEdit(req, res, root)`
   beside `handlePromptCancel` — `readPostBody(req, res, '{"role": "qa", "file": "<stamp>.md", "text": "..."}')`;
   role optional exactly like cancel (`body.role !== undefined && rejectBadRole(...)` → 400, default
   `DIRECTOR_ROLE`); `queueFileNameProblem(body.file)` → 400; `checkedPromptFields(res, body, role)`
   → 400 on a null return (the text and images validators `/api/prompt` and `/api/prompt-role`
   share); then `editQueuedFile(root, role, body.file as string, fields.text, fields.images)` in a
   try/catch, answering its thrown message 400 (the same mapping the CLI's `prompt --edit` wrapper
   applies to the combined body-plus-image cap; a filesystem failure reads as 400 like
   `handleConfigSet`'s failed write); `edited` → 200 `{ ok: true, status: "edited", oldText,
   newText }`, `gone` → 200 `{ ok: true, status: "gone" }`. Import `editQueuedFile` from
   `../inbox/inbox-edit.js`; update the module doc's POST list.
5. `src/gui/gui-server.ts`: import `handlePromptText` from `./gui-endpoints.js` and
   `handlePromptEdit` from `./gui-endpoint-commands.js`; add `"GET /api/prompt-text": (_req, res,
   target) => handlePromptText(target.searchParams, res, root)` beside `"GET /api/transcript"` and
   `"POST /api/prompt-edit": (req, res) => handlePromptEdit(req, res, root)` beside
   `"POST /api/prompt-cancel"`.

**Files touched.** `src/inbox/inbox-attachments.ts`, `src/inbox/inbox-edit.ts`,
`src/gui/gui-endpoints.ts`, `src/gui/gui-endpoint-commands.ts`, `src/gui/gui-server.ts`,
`test/inbox-edit.test.ts`, `test/gui-endpoints.test.ts`.

**Acceptance criteria.**
- `test/inbox-edit.test.ts`: `editQueuedFile(root, "qa", "q.md", "new text")` rewrites the named
  queue file in place (same basename, new body) and returns `{ status: "edited", oldText, newText }`;
  a name failing `queueFileNameProblem` (`"../x.md"`, `"q.txt"`) throws and touches nothing; a
  missing file returns `{ status: "gone" }`; an attached `q.md` keeps its `[image attached: …]`
  line and image file through the file-addressed entry point. `readQueuedPromptBody` returns the
  body without the not-before marker and without the `[image attached: …]` lines (a marked,
  attached file as the fixture), `null` for a vanished file, and throws on a bad name.
- `test/gui-endpoints.test.ts`: a `servePromptText(root, "?role=qa&file=q.md")` helper (the
  `handleTranscript`-style GET helper) answers 200 `{ ok: true, text: "…" }` for a seeded queue
  file and `{ ok: true, status: "gone" }` for an absent one; a bad or missing `file` is 400 naming
  the guard's message; a `role` the repo does not know is 400 through `rejectBadRole`. A
  `servePromptEdit(root, { role: "qa", file: "q.md", text: "new" })` helper (the `fakeReq` POST
  helper) answers 200 `{ ok: true, status: "edited", oldText, newText: "new" }`, and the file on
  disk holds the new body while a sibling queue file is intact; a bad file name and an over-cap
  text are 400; an absent file answers `{ ok: true, status: "gone" }`; a missing `file` is 400.
- `npm run test` is green.


### Search the TUI History pane with `tumwater history --grep`'s rule (planned 2026-10-11 by plan; sibling of the landed `tumwater history --grep`, the landed dashboard History search, and the landed TUI History `Ctrl+S`/`Ctrl+O`/`Ctrl+G` filters; completes the last `history` filter without a TUI surface; independent of the waiting TUI Pending land-queue plan — it shares `src/ui/tui/tui-keys.ts` and `tui-frame.ts` but edits the History pane's branches, the prompt-line modes, and the history view shape, not the Pending branch, so a landing conflict is possible and the resolver handles it; done 2026-10-11 by feature)

**Goal.** The History pane filters by trailing window (`Ctrl+S`), outcome class (`Ctrl+O`), and exact loop (`Ctrl+G`), but a free-text search has no TUI surface: `tumwater history --grep <text>` and the dashboard's History search field both filter the rows through `history-data.ts`'s `tickRowGrepHaystack` case-insensitive substring rule. Add that search to the TUI, reading the same haystack so the three surfaces cannot disagree.

**Approach.**
1. `src/ui/tui/tui-keys.ts`: import `tickRowGrepHaystack` from `../../history/history-data.js`.
   - `historyPaneCache` gains a fifth parameter `grep: string | null`. After the role/window read, apply the outcome class as today, then `if (grep !== null) filtered = filtered.filter((r) => tickRowGrepHaystack(r).toLowerCase().includes(grep.toLowerCase()))`. Capture `const afterGrep = <rows after the result filter and before grep>` so the empty-body wording can tell which filter emptied the set. Add `search: <grep>` to the `header` array after the existing role/window/result labels. Empty body: mirror `tumwater history`'s precedence (`src/history/history.ts`): name the result class when it emptied a set grep admitted (`resultClass !== null && afterGrep > 0` → `no ticks with result "<class>"`), else name the pattern when one is set (`no ticks matching "<grep>"`), else return `""` (the pane's own no-ticks note).
   - Pass `historyGrep` at every `historyPaneCache` call site: the `Ctrl+T` History entry, the `Ctrl+G`, `Ctrl+S`, and `Ctrl+O` handlers, and `syncSnapshot`'s stale-scope recompute.
   - New session state beside `historyResult`/`historyRole`: `let historyGrep: string | null = null` (the applied filter) and `let searchMode = false` with `searchSavedInput`/`searchSavedCursor` (its own saved-draft pair, exactly like the budget and role-prompt editors). Add `exitHistorySearch()` restoring `input`/`cursor` from the saved pair and clearing `searchMode`.
   - Add a branch before the arrow/return/`applyKey` tail, after the `Ctrl+T` branch: `if (!key.ctrl && str === "/" && !searchMode && !budgetMode && !rolePromptFor && view === roleIds.length + 4 && input === "")` → enter search: save the (empty) draft, set `searchMode = true`, prefill `input = historyGrep ?? ""`, `cursor = input.length`, flash `search ticks: Enter to filter, Esc to cancel`. `/` is the pager search key and this project already reserves `/` for a meta action (the dashboard composer's jump-to-composer hint); guarding on the empty line leaves a director draft untouched, and off History `/` still types into the prompt line.
   - `Enter` gains a `searchMode` arm first: `historyGrep = input.trim() === "" ? null : input.trim()`, `exitHistorySearch()`, recompute `paneCache = historyPaneCache(root, historyWindow, historyResult, historyRole, historyGrep)`, reset `paneScroll = 0`, flash `search: "<grep>"` or `search cleared`.
   - `Escape` gains a `searchMode` arm (cancel without applying, restore the draft). `Ctrl+T` calls `exitHistorySearch()` beside the budget/role exits (the applied `historyGrep` persists across view cycling, like `historyWindow`/`historyResult`). Guard the `Ctrl+G`/`Ctrl+S`/`Ctrl+O` handlers and the `Up`/`Down` prompt-history recall with `!searchMode`, mirroring how budget and role-prompt modes make them inert.
   - Expose `historyGrep: string | null` on `TuiKeysState` (interface and getter).
2. `src/ui/tui/tui-frame.ts`: the `TuiView` `history` variant gains `grep: string | null`; the history arm of `hintLine` adds `["/", view.grep ? `search: ${view.grep}` : "search"]`. `tabStrip` is unchanged (the pane's own `search:` header names the active pattern).
3. `src/ui/tui/tui.tsx`: the History pane construction passes `grep: s.historyGrep`.
4. `docs/how-it-works.md`: the TUI bullet's History sentences add the search — `/` on the History pane filters by the same `tickRowGrepHaystack` haystack `tumwater history --grep` and the dashboard search use, Enter applies and names the pattern, Esc cancels.

**Files touched.** `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`, `test/tui-keys.test.ts`, `test/tui-frame.test.ts`, `test/tui-history.test.ts`, `docs/how-it-works.md`.

**Acceptance criteria.**
- `test/tui-keys.test.ts`, a new case with seeded `tick_end` events whose rendered rows differ: cycle to History, press `/` with an empty line, type a substring, press Enter — `state().historyGrep` equals the trimmed text and `state().paneCache` holds only the matching rows; re-open `/` and submit an empty line — `historyGrep` is `null` and the full rows return. Esc during search leaves `historyGrep` unchanged and restores the pre-search prompt text. `/` off the History view, and on History with a non-empty line or in budget/role-prompt mode, does not enter search (it types into the prompt line or is ignored as today). `Ctrl+G`/`Ctrl+S`/`Ctrl+O` and `Up`/`Down` are inert while search holds the line.
- `test/tui-frame.test.ts`: a history view with `grep: "widget"` shows `search: widget` in `hintLine`, while `grep: null` shows `search`; the existing history hint/tab cases and the all-views `Ctrl+D` loop stay green (their history literals gain `grep: null`).
- `test/tui-history.test.ts`'s expectations are unchanged (`historyPaneText` still renders whatever rows it is handed); its two `TuiView` history literals gained `grep: null` for the new required field.
- `docs/how-it-works.md` describes the History search and names `tumwater history --grep` as the CLI rule it shares.
- `npm run test` is green.

### Clear a curated config key from the dashboard Settings view, matching `tumwater config unset` (planned 2026-10-11 by plan; sibling of the landed CLI `tumwater config unset <key>` and the landed dashboard Settings Save, which share `src/config/config-write.ts`'s `unsetConfigKey`/`setConfigKey`; the Settings view can set the curated keys but has no way to retract one, so an operator who set `notify` must drop to the CLI to remove it, and the README calls `unset` the inverse of `set`; independent of the waiting TUI Pending land-queue and TUI History grep plans in code — GUI/CLI only, no `src/ui/tui`, `src/history`, or `src/landing` file — though all three touch `docs/how-it-works.md`, so a doc landing conflict is possible and the resolver handles it; done 2026-10-11 by feature)

**Goal.** `tumwater config unset <key>` removes a value from tumwater.json so it reverts to its default or disappears from its map or section, and the dashboard's Settings view writes the same curated keys through Save — but it has no Clear affordance, so the dashboard can only add or overwrite keys, never retract one. Add POST `/api/config-unset` and a per-row Clear button, both going through the shared `unsetConfigKey` so the browser cannot drift from the CLI's rules.

**Approach.**
1. `src/gui/gui-endpoint-commands.ts`: add `handleConfigUnset(req, res, root)` mirroring `handleConfigSet` directly below it. Import `unsetConfigKey` from `../config/config-write.js` beside the existing `setConfigKey`. `readPostBody(req, res, '{"key": "model"}')`; gate `body.key` on `(EDITABLE_CONFIG_KEYS as readonly string[]).includes(key)` with the same 400 wording `handleConfigSet` uses (the `gotSuffix` convention for an absent key); call `unsetConfigKey(root, key)`; on `!result.ok` send 400 `{ error: \`${key}: ${result.error}\` }`; on success send 200 `{ ok: true, key, oldValue: result.oldValue }` (JSON omits `oldValue` when the file never held the key, so the client can tell a retraction from a no-op; a file value of `null` still serializes and is a real retraction).
2. `src/gui/gui-server.ts`: import `handleConfigUnset` from `./gui-endpoint-commands.js` and add the route `"POST /api/config-unset": (req, res) => handleConfigUnset(req, res, root)` next to `"POST /api/config-set"`.
3. `src/ui/gui/gui-client-settings.ts`: in `renderSettings`, after the Save button of each row, emit `<button type='button' class='btn btn-sm rowaction' data-action='unset'>Clear</button>`. Add `async function clearSetting(form)`: read `key = form.dataset.key`, `postJson("/api/config-unset", { key })`, then flash `"Unset " + key + " (was " + JSON.stringify(d.oldValue) + ")"` when `d.oldValue !== undefined`, else `"Nothing to unset for " + key + " — it was already the default"`; on success `await fetchSettings()` so the field repaints with the reverted resolved value (unsetting `maxDailyCostUsd`, for example, restores the default 50, not an empty field); on error flash the `"error: " + (err && err.message ? err.message : String(err))` pattern `saveSetting` uses. Update the module doc comment to name the unset half.
4. `src/ui/gui/gui-client-boot.ts`: beside the existing delegated `submit` listener for `form.settings-row`, add a delegated `click` listener that resolves `button[data-action='unset']` through `clickClosest`, walks to its `form.settings-row`, and calls `clearSetting(form)` — no per-row wiring, so the panel repaints freely.
5. `docs/how-it-works.md`: the Settings sentence (the one naming the inline Save buttons and `tumwater config set`) adds the Clear button and names `tumwater config unset` as the shared path, noting the field reverts to the key's default.

**Files touched.** `src/gui/gui-endpoint-commands.ts`, `src/gui/gui-server.ts`, `src/ui/gui/gui-client-settings.ts`, `src/ui/gui/gui-client-boot.ts`, `test/gui-endpoints.test.ts`, `test/gui-client-settings.test.ts`, `docs/how-it-works.md`.

**Acceptance criteria.**
- `test/gui-endpoints.test.ts`, a `serveConfigUnset` helper and new cases beside the config-set ones: with `{ model: "gpt-5", quietHours: "23:00-07:00" }` on disk, `handleConfigUnset(root, { key: "model" })` answers 200 `{ ok: true, key: "model", oldValue: "gpt-5" }`, the file on disk no longer holds `model`, and `quietHours` is intact; a key outside `EDITABLE_CONFIG_KEYS` (`customLoops`) and a body with no `key` are 400 with the same wording `handleConfigSet` uses; unsetting a key the file never held answers 200 with no `oldValue` and leaves the file byte-identical.
- `test/gui-client-settings.test.ts`: `renderSettings` emits one `data-action='unset'` Clear button per curated key (alongside the existing per-row Save counts); `clearSetting` posts `{ key: "model" }` to `/api/config-unset` and flashes `Unset model (was "gpt-5")`, flashes `Nothing to unset for …` when the response omits `oldValue`, and flashes the `error:` pattern on a thrown refusal; the existing `saveSetting` cases stay green; a string assertion pins `GUI_CLIENT_BOOT_JS` to the `data-action='unset'` click selector, beside its existing `settings: "settings-view"` routing assertions.
- `docs/how-it-works.md` describes the Settings Clear action and names `tumwater config unset` as the path it shares.
- `npm run test` is green.

### Show the durable land queue in the TUI Pending pane, matching `tumwater queue` (planned 2026-10-11 by plan; sibling of the waiting dashboard Pending-view land-queue plan and of the landed `tumwater queue` CLI command, and the TUI half of that read surface; independently landable — it reuses `src/landing/landing-queue.ts`'s `readLandingQueue` and `src/landing/landing-queue-render.ts`'s `renderLandingQueue`, the CLI's own reader/renderer, rather than a copy, so the CLI, dashboard, and TUI cannot drift; shares `src/ui/tui/tui-keys.ts` with the waiting role-scoped TUI History plan — a landing conflict is possible and the resolver handles it; no new view, key, or hint; done 2026-10-11 by feature)

**Goal.** The TUI's Pending pane (`Ctrl+T` to Pending; `tui-keys.ts`'s `view ===
roleIds.length + 5` branch) renders only `collectFleetChanges`'s unlanded-change roster, while
`tumwater queue` lists the durable land queue and the dashboard Pending plan adds the same
entries to its view. Add the queue above the roster in the TUI pane, reading and rendering it
through the CLI's existing `readLandingQueue`/`renderLandingQueue` pair so the three surfaces
agree on order, age, skips, and wording.

**Approach.**
1. `src/ui/tui/tui-keys.ts`: import `readLandingQueue` from
   `../../landing/landing-queue.js` and `renderLandingQueue` from
   `../../landing/landing-queue-render.js`. In the Pending branch, before kicking off the async
   collector, compute `const queueText = renderLandingQueue(readLandingQueue(root), now())` —
   the factory's injected `now` clock, so the printed age is pinnable in a test — and set
   `paneCache = queueText` immediately, so the queue paints on entry instead of waiting on git
   plumbing.
2. In the collector's resolution arm, keep the existing "the Pending view is still current"
   guard and set `paneCache = queueText + "\n\n" + renderFleetChange(fleet)`. In the rejection
   arm, keep the queue visible (`paneCache` stays `queueText`) and `flashError(err)` as today,
   rather than leaving the loading note over a queue that is already known.
3. `src/ui/tui/tui-pane.ts`'s pending branch is unchanged: it windows whatever string
   `paneCache` holds, so the queue-plus-roster text flows through its existing
   `entryBodyWindow`. No new view, `Ctrl+T` index, `tabStrip` label, or `hintLine` key; no
   change to `tui-frame.ts` or `tui.tsx`.

**Files touched.** `src/ui/tui/tui-keys.ts`, `test/tui-keys.test.ts`,
`docs/how-it-works.md` (the TUI bullet's Pending sentence names the land queue above the
roster, beside the existing "`Ctrl+O` cycles the pane's outcome filter" sentence).

**Acceptance criteria.**
- `test/tui-keys.test.ts`, a new case: seed one queue entry with
  `enqueueLanding(root, { role: "feature", sha: "…", tick: 3, summary: "…", enqueuedAt: 0 })`
  and wire a `collectPending` that returns a two-role `FleetChangeView`; `syncSnapshot`, then
  `Ctrl+T` five times into Pending. Before the collector resolves, `state().paneCache` equals
  `renderLandingQueue(readLandingQueue(root), 0)` — the queue renders without the git read. After
  it resolves, `state().paneCache` equals that same queue text plus `"\n\n"` plus
  `renderFleetChange(fleet)`. With no queue files seeded, the queue half is `land queue empty`.
- The existing pending cases stay green: a resolution after the operator cycled away, and one
  after a roster change remapped the raw index onto another view, both still write no cache —
  the shifted-view case now asserts the cache is unchanged, still the queue text written on
  entry, rather than null; the pre-resolution `paneCache === null` assertion in
  "the Pending pane caches the rendered fleet roster…" becomes the queue text (the immediate set
  is the behavior change).
- `docs/how-it-works.md`'s TUI bullet says the Pending pane shows the land queue above the
  pending-change roster, naming `tumwater queue` as the CLI view it matches.
- `npm run test` is green.

### Run the configured notify hook once: `tumwater notify --test` (planned 2026-10-10 by plan; independent of the waiting TUI Usage/Failures `--since`, TUI History `--result`, and `tumwater queue` plans — a new CLI command over `src/events/notify.ts` and `src/config`, no `src/ui/tui`, `src/history` or `src/landing` file; completes the operator's push channel, which today can only be exercised by waiting for a real event; done 2026-10-10 by feature)

**Goal.** The `notify` hook (tumwater.json's `notify` shell command, run by
`newNotifier` on nine allowlisted events) is the fleet's one push channel, but an operator who
writes one has no way to check it: the hook fires only when a budget pause, failed landing, or
posted question happens. Add `tumwater notify --test`: run the configured command once with a
synthetic `TUMWATER_EVENT_TYPE`/`TUMWATER_EVENT_LOOP`/`TUMWATER_EVENT_MESSAGE` environment,
inherit its stdio so its effect (a desktop notification, a posted webhook, an appended line) is
visible, and report its exit code. The default is opinionated and single: one fixed
representative allowlisted event (`land_failed`, loop `harness`, message `tumwater notify
--test`), no per-type or per-message flags — the goal is to prove the hook runs, not to replay
a specific page.

**Approach.**
1. `src/events/notify.ts`: add `export function notifyCommandEnv(type: string, loop: string,
   message: string): NodeJS.ProcessEnv` returning `childEnv({ TUMWATER_EVENT_TYPE: type,
   TUMWATER_EVENT_LOOP: loop, TUMWATER_EVENT_MESSAGE: message })`, and use it in
   `newNotifier`'s spawn (`env: notifyCommandEnv(event.type, event.loop,
   stripTerminalControls(formatEvent(event)))`). The three variable names then have one home,
   so the notifier and the test command cannot drift.
2. New `notify-command.ts` in `src/cli/` (the command-module convention beside
   `src/cli/log-commands.ts`): module constants `NOTIFY_TEST_TYPE = "land_failed"`,
   `NOTIFY_TEST_LOOP = "harness"`, `NOTIFY_TEST_MESSAGE = "tumwater notify --test"`; and
   `export async function cmdNotify(root: string, args: string[]): Promise<void>`:
   - `if (!args.includes("--test")) fail("usage: tumwater notify --test")`.
   - `const command = loadConfig(root).notify`; when it is not a non-empty string,
     `fail("notify is not configured (set `notify` in tumwater.json)")`.
   - `say(`running the notify hook (TUMWATER_EVENT_TYPE=${NOTIFY_TEST_TYPE}) …`)`, then await a
     local `runNotifyHook(command, env): Promise<number>` helper — `spawn(command, [], {
     shell: true, stdio: "inherit", env })`, resolve the `close` code (`?? 1`) and resolve
     `127` on the `error` event. Unlike the notifier's detached fire-and-forget spawn, this one
     is awaited with inherited stdio, so the operator sees the hook's own output and its exit.
   - `code === 0` → `say("notify hook exited 0")`; otherwise
     `say(`notify hook exited with code ${code}`)` and `process.exitCode = 1`.
   - No event is logged: a test run is a diagnostic and leaves the event log and every other
     harness state file untouched.
3. `src/cli.ts`: import `cmdNotify`; add a `case "notify":` beside `case "logs":`:
   `rejectUnknownArgs("notify", args, [{ names: ["--test"] }])`, then `await
   requireReadyRepo(root)`, then `await cmdNotify(root, args)`.
4. `src/cli/help.ts`: add a `  tumwater notify --test` stanza beside the `logs` stanzas —
   "Run the configured notify hook once with a synthetic event so the command can be checked
   before a real page".
5. `README.md`: in the settings paragraph's `notify` parenthetical, add "verify it with
   `tumwater notify --test`".
6. No new runtime dependency; the notifier's firing behavior, the allowlist, and the
   orchestrator wiring are unchanged — only the env-var names move behind the new helper.

**Files touched.** `src/events/notify.ts`, a new `notify-command.ts` in `src/cli/`, `src/cli.ts`,
`src/cli/help.ts`, `README.md`, `test/notify.test.ts` (the pinned env assertions stay green
with `newNotifier` now using the helper), a new `notify-command.test.ts` in `test/`,
`test/help.test.ts`.

**Acceptance criteria.**
- `test/notify.test.ts`, a new case: `notifyCommandEnv("budget_paused", "feature", "m")`
  returns exactly those three `TUMWATER_EVENT_*` keys and values. The existing spawn/env cases
  stay green (the notifier's rendered message and throttle are unchanged).
- A new `notify-command.test.ts` in `test/` over `initializedRepo()` with `setConfigKey(repo,
  "notify", recorderCommand(out))` (the `test/notify.test.ts` recorder: `echo
  "$TUMWATER_EVENT_TYPE|$TUMWATER_EVENT_LOOP|$TUMWATER_EVENT_MESSAGE" >> <out>`) and the
  `cli(repo, ...)` harness: bare `notify` exits non-zero naming `usage: tumwater notify --test`;
  with no `notify` configured, `notify --test` exits non-zero naming the missing setting; with
  the recorder it exits 0, records exactly one line whose fields are
  `land_failed|harness|tumwater notify --test`, and its stdout names the hook run; a hook that
  exits 3 makes `notify --test` exit non-zero and print the code.
- `test/help.test.ts`: `ALL_COMMANDS` gains `"notify"` (its "names exactly the commands the full
  help lists" case then passes), and `helpTopic("notify")` starts `  tumwater notify`.
- `npm run test` is green.

### Role-scoped History pane in `tumwater tui`, matching `tumwater history --role <id>` (planned 2026-10-11 by plan; sibling of the landed GUI History Loop picker (`histRole` in src/ui/gui/gui-client-history.ts) and of the landed TUI `Ctrl+G` report scope; the TUI History pane filters by trailing window (Ctrl+S) and outcome class (Ctrl+O) but not by loop, so the exact-loop filter `tumwater history --role <id>` and the dashboard picker both have no TUI surface; independent of the waiting `tumwater notify --test`, dashboard land-queue, and remainder-and-cause plans — TUI-only, no `src/cli`, `src/events`, `src/landing`, or `src/failure` file; done 2026-10-11 by feature)

**Goal.** `tumwater history --role <id>` filters tick rows to one loop's exact id, and the
dashboard's History view has a Loop picker for it, but the TUI's History pane shows only the
fleet-wide read — an operator watching a busy fleet cannot narrow the pane to one loop. Add a
session loop scope to the pane, cycled with `Ctrl+G` (the panes' scope key), so the TUI, the CLI,
and the GUI read the same rows. History's filter is exact-loop, not the report panes' base-role
aggregation: the scope cycles the raw `roleIds` (so `feature` and `feature-2` are separate slots),
matching `tumwater history --role` and the GUI picker, and never runs through `scopeCycle`/`baseRoleOf`.

**Approach.**
1. `src/ui/tui/tui-keys.ts`:
   - `historyPaneCache(root, sinceMs, resultClass, role: string | null)` gains the role and
     passes it to `readTickRows(root, HISTORY_DEFAULT_TICKS, role)` and
     `readTickRowsSince(root, sinceMs, role)` (both already take it). Prefix the pane header,
     when `role !== null`, with a `role: <role>` line beside the existing `window:`/`result:`
     labels. Keep the current empty-return rule (a role-only empty read returns `""`, so the
     pane's `(no ticks yet)` note stands, exactly as the CLI's empty-state wording does not name
     `--role`).
   - Add `let historyRole: string | null = null` beside `historyResult`, add
     `historyRole: string | null` to `TuiKeysState`, and return it from the state getter.
   - In the `Ctrl+G` branch: when the current view is History (`view === roleIds.length + 4`),
     cycle `historyRole` through `[null, ...roleIds]` (the raw roster ids; the same list the GUI
     picker and `tumwater history --role` use) via the index-of-then-`+1`-mod-length pattern,
     then recompute `paneCache = historyPaneCache(root, historyWindow, historyResult, historyRole)`
     and reset `paneScroll = 0`; on every other view keep cycling `scopeRole` for Usage/Failures
     exactly as today. `deps.requestRender()` in both arms.
   - Every other `historyPaneCache` call site (the Ctrl+T History entry, `Ctrl+S`, `Ctrl+O`)
     passes `historyRole`.
   - `syncSnapshot`: when `historyRole` is non-null and the incoming `roles` no longer includes
     it, reset it to null (mirroring the existing `scopeRole` reset), so a retired loop's id
     never labels an empty pane.
2. `src/ui/tui/tui-frame.ts`: the `TuiView` `history` variant gains `role: string | null`;
   `tabStrip` labels the tab `History: <role>` when scoped and plain `History` otherwise (mirroring
   `Usage`/`Failures`); the history arm of `hintLine` gains
   `["Ctrl+G", view.role ? `scope: ${view.role}` : "scope: fleet"]` after the scroll hint, so the
   key and the current loop are both on screen.
3. `src/ui/tui/tui.tsx`: the History pane construction passes `role: s.historyRole`.
4. No change to `tui-pane.ts` (the cache already is the pane body), the collectors, or any other
   surface; no new runtime dependency.

**Files touched.** `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`,
`test/tui-keys.test.ts`, `test/tui-frame.test.ts`.

**Acceptance criteria.**
- `test/tui-keys.test.ts`, a new case with `syncSnapshot(0, false, ["feature", "feature-2", "clean"])`
  and seeded `tick_end` events for two loops: after cycling to History, `Ctrl+G` moves
  `state().historyRole` from `null` to `"feature"` to `"feature-2"` to `"clean"` to `null` — the
  instance id is its own slot, unlike the report scope — and each press on the History view
  recomputes `paneCache` so a scoped cache differs from the fleet-wide one; `Ctrl+G` leaves
  `historyRole` unchanged while budget mode or role-prompt mode holds the prompt line; a later
  `syncSnapshot` whose roster drops the scoped loop resets `historyRole` to null. The existing
  Ctrl+G report-scope cases stay green (other views still cycle `scopeRole`).
- `test/tui-frame.test.ts`: `tabStrip({ kind: "history", since: null, result: null, role: "feature" },
  200)` shows `History: feature` while `role: null` shows `History`; `hintLine` for a history view
  carries `Ctrl+G scope: feature` under a scope and `Ctrl+G scope: fleet` without one. The
  existing history window/result hint cases and the all-views `Ctrl+D` loop stay green (their
  literals gain `role: null`).
- `test/tui-history.test.ts`'s `paneBody` history cases stay green (their literals gain
  `role: null`; the pane body reads the already-scoped cache, not the role).
- `npm run test` is green.

### A remainder-and-cause trace: a capped view discloses what it dropped, and a failed decision records the cause it acted on (planned 2026-10-10 by steward; promoted from the `no-observability` validation gap, carried by 58 Fixed entries — the largest non-`none` tag after `unclear-invariant`; independent of the Agent backends and citation-sweep series; follow-up to the landed invariant register and its citation guard; done 2026-10-11 by feature)

**Goal.** Retire the `no-observability` gap. It is recorded when a failure or a wrong decision
left no trace, so a fixer could neither detect it nor reconstruct the inputs it acted on. Give the
project a trace contract with two rules a landing can be checked against: **a capped or narrowed
view discloses in its output what it dropped**, and **a terminal failure records the cause it
decided from rather than a defaulted pass or a bare count**.

**Evidence.** The validation-gap tally (`grep -oE 'gap:[*]{0,2} ?[a-z-]+' BUGS.md | sed -E
's/^gap:[*]{0,2} ?//' | sort | uniq -c`) shows `no-observability` on 58 Fixed entries, second only
to `unclear-invariant` (97) and the largest tag with no retiring infrastructure plan; 9 are still
kept verbatim and the rest survive as `; gap: no-observability` one-liners. The recurring families,
each visible in the cited entries:
- **A capped section prints no remainder.** The failure digest's loss ranking keeps the top 5
  causes and itemizes the rest nowhere ("The failure digest's 'Top loss causes by time' ranking is
  cut to the top 5 causes by time…", fixed 2026-10-01), while sibling sections already disclose
  their cuts (`+21 more`, `+46 more`); its Review rejections section truncates at 5
  alphabetically-first clusters ("The digest's Review rejections section silently truncates at 5
  alphabetically-first clusters…"), and its Fleet state changes section keeps only the newest 6
  transitions ("The digest's Fleet state changes section silently keeps only the newest 6
  transitions…").
- **A failure path records a pass, a silence, or a bare count.** A malformed FLOW line defaults to
  `passed` ("A FLOW line without a parseable verdict is recorded as a pass…"); a signal-killed
  build check is reported as a timeout ("A build check killed by a signal is reported as 'timed
  out after 300s'…"); `quiet_killed` is the only outcome with no strike cap, backoff, or alarm
  ("`quiet_killed` is the only tick outcome with no strike cap, no backoff and no alarm…"); a
  persistent review failure never reaches the error-streak alarm ("A persistent review failure
  never reaches the error-streak alarm…").
- **A label names the wrong evidence.** Build-check rejections name a stack frame instead of the
  failing test ("Build-check rejections name the stack frame instead of the failing test…"); a
  role over-cap rejection names the director's prefill whatever loop it targets ("A role prompt's
  over-cap rejection names the director's prefill whatever loop it targets…").
Seed the contract from these families, and add sections as new ones recur.

**Approach.**
1. Add one shared remainder helper beside the render/text helpers, producing the digest's existing
   `_+N more … not listed_` / `(+N unreadable …)` shape, and apply it to every view that currently
   cuts silently — starting with the digest's loss ranking, Review rejections, and Fleet state
   changes, and the per-role rejection counter. The count is derived from the same list the view
   already builds, so the marker cannot drift from the cut.
2. Give the terminal-outcome paths a cause field. `extractFlow` and the killed-specific-check
   paths record the observed cause (a malformed/truncated verdict, a signal kill) as a distinct
   value, never a defaulted `passed`; `quiet_killed` and the other unalarmed outcomes feed the
   existing streak/backoff machinery. A wrong or absent cause is then an assertion a test can fail
   on, not prose.
3. State the contract where a fixer reads it. Name the trace rule in the invariants register
   (docs/invariants.md) beside the boundary families, so a landing that adds a capped view or a
   terminal outcome updates the record shape in the same commit.
4. No new runtime dependency and no change to the loop pipeline.

**Files touched.** the render/text helpers and `src/failure/` renderers; `src/verdict/` (extractFlow)
and the build-check/kill outcome paths; `docs/invariants.md`; the `test/...` cases below.

**Acceptance criteria.**
- A digest render seeded with more loss causes, review clusters, and fleet transitions than each
  section's cap prints the marked remainder (hidden count, not silent), under a test per section;
  the cap-size-seeded render is byte-unchanged.
- A malformed or truncated FLOW line records a non-`passed` outcome, and a signal-killed build
  check event carries its kill cause distinct from a timeout, each under a test.
- The invariants register states the remainder-and-cause rule and cites the `test/...` cases that
  pin it, so the citation guard (the landed "Keep the invariant register honest…") covers the new
  sections.
- `npm run test` is green.

**Landed.** The capped-section remainder lines and both cause recordings this plan asked for
already rode individual fixes before this tick; they are now stated and pinned as the register's
`INV-D1`/`INV-D2` contract (docs/invariants.md). This tick added that register entry and moved
this plan to Done. No shared remainder helper was extracted: the four digest remainders carry
different wording ("older transitions hidden", "loss causes by time not listed", "clusters
holding N", "older merges not listed") and already share the `agree`/`plural` helpers, so a
single formatter would add parameters without removing a computation.

### Show the durable land queue in the dashboard's Pending view, matching `tumwater queue` (planned 2026-10-10 by plan; sibling of the landed `tumwater queue` CLI command and the landed dashboard Pending view; completes the land queue's read surfaces on the dashboard, which today show only the header depth badge `· land queue: N` — the entries already ride `/api/status`'s `landQueue.entries` and are polled every second but never painted; independent of the waiting TUI History `--result`, CLI `notify --test`, and remainder-and-cause trace plans — GUI-only, no `src/ui/tui`, `src/history`, `src/events`, or `src/failure` file; done 2026-10-11 by feature)

**Goal.** The dashboard's Pending view shows every loop's unlanded change (from `/api/diff`) and
its header badge shows the queue depth (`· land queue: N`, src/ui/badges.ts `landingBadge`), but
the waiting landings themselves — role, tick, short sha, age, summary, in execution order — are
visible only through `tumwater queue` or `tumwater status --json`. The status payload the page
already polls each second carries them at `landQueue.entries` (StatusSnapshot, filled from
`readLandingQueue`). Paint a "Land queue" card at the top of the Pending view from that payload,
so an operator watching the browser sees what the landing slot will merge next without leaving
the page.

**Approach.**
1. `src/ui/gui/gui-client-pending.ts`, inside the `pending-table` marked region (so `clientScope`
   can run it): add the pure `pendingQueueHtml(landQueue, now)`.
   - Non-empty readable `entries`: one row per entry in array order, `<n>. <role> tick #<tick> ·
     <shortSha(sha)> · <humanSeconds((now - enqueuedAt) / 1000)> ago · <summary>` — the same
     fields and order as `renderLandingQueue` (src/landing/landing-queue-render.ts), so the page
     and the CLI cannot drift. `shortSha`/`humanSeconds` come from the assembled script's
     `format` region (the test already loads it beside `pending-table`) and `esc` from the
     script's own `esc`.
   - `landQueue` absent or `depth === 0`: `Land queue empty`.
   - `depth > 0` with `entries` absent or not an array: `land queue: <depth> waiting` (the depth
     also counts the unreadable queue files the status reader skips; the payload carries no
     split, so the card states the count without inventing an itemization).
   - Guard a non-array `entries`, a missing `sha`, and a non-finite `enqueuedAt` so no row prints
     `undefined` or `NaN`.
2. `buildPendingView()` gains a `<div class="card" id="pendingqueue">` above `#pendingbody`, and
   `fetchPending()` paints it through a `renderPendingQueue()` that reads `lastStatus &&
   lastStatus.landQueue` (the polled payload, no new fetch) and calls `pendingQueueHtml` with
   `Date.now()`.
3. `src/ui/gui/gui-client-boot.ts`: `rerender()` gains `if (activeView === "pending")
   renderPendingQueue(lastStatus);` beside its fleet line, so the card tracks the one-second
   status poll while the view is open; the roster keeps its own open/Refresh `/api/diff` fetch.
4. No server change: `landQueue.entries` already rides `/api/status` (src/ui/status-payload.ts
   passes `snap.landQueue` through), and the Pending view's pure-function test seam already
   loads the `format` region.

**Files touched.** `src/ui/gui/gui-client-pending.ts`, `src/ui/gui/gui-client-boot.ts`,
`test/gui-client-pending.test.ts`.

**Acceptance criteria.**
- `test/gui-client-pending.test.ts`, a new case over `pendingQueueHtml({ depth, entries }, now)`
  with two entries: the rows appear in array order, each carrying its 1-based position, role,
  `tick #<tick>`, the sha's first eight characters, an age derived from the fixed `now`, and the
  summary.
- `pendingQueueHtml({ depth: 0 }, now)` and `pendingQueueHtml(null, now)` both carry `Land queue
  empty`; `pendingQueueHtml({ depth: 2 }, now)` with the readable list absent carries `land
  queue: 2 waiting`.
- An escaping case (a role and summary containing markup render escaped) and a malformed-
  document case (`entries` not an array, `sha`/`enqueuedAt` missing) render without `undefined`
  or `NaN`.
- The existing `pendingTableHtml` cases stay green, and `GUI_CLIENT_JS` still carries the module
  verbatim (its existing case covers the new function, which lives in the same region).
- `npm run test` is green.
### Filter the TUI History pane by outcome class, matching `tumwater history --result` (planned 2026-10-10 by plan; sibling of the landed CLI `tumwater history --result <changes|none|problems>` and the landed dashboard History outcome filter; completes that outcome filter on the TUI's History pane, reading the same canonical `historyClass` rule from `src/history/history-data.ts`; shares `src/ui/tui/tui-keys.ts`/`tui-frame.ts` with the waiting TUI Usage/Failures `--since` plan — both add one session cycle and one hint pair — so a landing conflict is possible and the resolver handles it; done 2026-10-10 by feature)

**Goal.** The TUI History pane now offers the `Ctrl+S` trailing window (landed), but it renders
`readTickRows`/`readTickRowsSince` rows unfiltered, while `tumwater history --result
<changes|none|problems>` and the dashboard's History view narrow ticks to one outcome class
(Changes / No change / Problems). Add a session-only outcome cycle keyed `Ctrl+O` (mnemonic:
**O**utcome) that keeps only rows whose result falls in the active class, composing with the
active trailing window, and surface the active class in the hint line. The pane reuses
`history-data.ts`'s `historyClass`/`HISTORY_RESULT_CLASSES` rather than a copy, so the TUI, the
CLI, and the dashboard bucket a result the same way.

**Approach.**
1. `src/ui/tui/tui-keys.ts`: import `historyClass`, `HISTORY_RESULT_CLASSES`, and `type
   HistoryResultClass` from `../../history/history-data.js`. Add a module constant
   `HISTORY_RESULTS: ReadonlyArray<[HistoryResultClass | null, string]>` = `[[null, "all"],
   ...HISTORY_RESULT_CLASSES.map((c) => [c, c] as const)]` — the label is the class id, matching
   the CLI's accepted values, and the class list comes from `history-data.ts` rather than a copy —
   and a module helper `historyResultLabel(resultClass: HistoryResultClass | null): string |
   null` (the table lookup, null only for a would-be stale value). Add `let historyResult:
   HistoryResultClass | null = null` beside `historyWindow`, commented session-only like it.
2. Extend the existing `historyPaneCache` to `historyPaneCache(root, sinceMs, resultClass)`. The
   default path (`sinceMs === null && resultClass === null`) stays byte-for-byte the current
   `historyPaneText(readTickRows(root, HISTORY_DEFAULT_TICKS, null))`. Otherwise read through the
   window collector (`readTickRows` for the default, `readTickRowsSince` otherwise), filter
   `resultClass === null ? rows : rows.filter((r) => historyClass(r.result) === resultClass)`,
   and render header lines — `window: last <label>` when a window is active and
   `result: <label>` when a class is active — followed by the filtered body. When a class is
   active, the unfiltered read returned rows (`rows.length > 0` — the CLI's `afterGrep > 0` and
   the dashboard's `hasRows` rule), and the filtered body is empty, return the header plus
   `no ticks with result "<label>"` (the CLI's exact wording); otherwise (no class, or the read
   itself was empty) return `""` so an empty log or window keeps the pane's own `(no ticks yet)`
   note rather than blaming a filter that removed nothing; keep `SPARSE_WINDOW_NOTE` when the
   since read is not `covered` and rows remain.
3. Add a `Ctrl+O` branch beside the `Ctrl+S` branch, gated `!budgetMode && !rolePromptFor` like
   it: advance `historyResult` to the next `HISTORY_RESULTS` entry (index-of, `+1` mod length);
   when `view === roleIds.length + 4` (History) recompute `paneCache = historyPaneCache(root,
   historyWindow, historyResult)` and set `paneScroll = 0` so the changed body re-enters at its
   head; always `deps.requestRender()`. Off the History view, setting `historyResult` is enough —
   the next Ctrl+T into History computes with it.
4. Pass `historyResult` at the two existing History call sites: the `Ctrl+S` recompute and the
   Ctrl+T History-entry `paneCache = historyPaneCache(root, historyWindow, historyResult)`.
5. Expose `historyResult: string | null` on `TuiKeysState` (the active label via
   `historyResultLabel`, null when none) and return it from `state()`, beside `historySince`.
6. `src/ui/tui/tui-frame.ts`: the `TuiView` `history` variant gains `result: string | null`;
   the `hintLine` history branch gains `["Ctrl+O", view.result ? \`result: ${view.result}\` :
   "result: all"]` after the `Ctrl+S` pair. `tabStrip` stays `History` unchanged.
7. `src/ui/tui/tui.tsx`: build the History pane as `{ kind: "history", since: s.historySince,
   result: s.historyResult }` from the state it already reads.
8. Update the existing `{ kind: "history", since: ... }` literals in `test/tui-frame.test.ts`
   and `test/tui-history.test.ts` to carry `result: null`.

**Files touched.** `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`,
`test/tui-keys.test.ts`, `test/tui-frame.test.ts`, `test/tui-history.test.ts`,
`docs/how-it-works.md`.

**Acceptance criteria.**
- `test/tui-keys.test.ts`, a new case: seed three `feature` `tick_end` events with results
  `changed`, `no_change`, and `error` (all inside the default newest-N read), `syncSnapshot(0,
  false, [])`, then Ctrl+T into History: `state().historyResult` is `"all"` and the pane carries
  all three. Ctrl+O cycles `"changes"`, `"none"`, `"problems"`, then back to `"all"`; under
  `"changes"` the pane carries the changed row and neither the no-change nor the error row, under
  `"none"` the no-change row alone, under `"problems"` the error row alone, and the body's header
  line reads `result: <class>`; each press on the History view resets `paneScroll` to 0. Compose
  with Ctrl+S: after Ctrl+S to `1h`, a filter whose only matching tick is older than an hour
  leaves the pane showing `no ticks with result "<class>"`. An active class over a read that
  returned zero rows (an empty log) leaves `paneCache` as `""`, keeping the pane's own no-ticks
  note. `docs/how-it-works.md`'s TUI section documents the `Ctrl+O` cycle beside the `Ctrl+S`
  window sentence.
- `test/tui-keys.test.ts`: Ctrl+O leaves `historyResult` unchanged while budget mode or
  role-prompt mode holds the prompt line, and pressing it off the History view changes the label
  without computing a cache (the off-view preamble Ctrl+S uses).
- `test/tui-frame.test.ts`: `hintLine({ kind: "history", since: null, result: "problems" }, ...)`
  carries a `Ctrl+O` hint naming `result: problems`, while `result: null` names `result: all`; the
  existing `{ kind: "history", ... }` literals there and in `test/tui-history.test.ts` gain
  `result: null` and their assertions are otherwise unchanged.
- The existing Ctrl+S History window cases stay green (the default path is unchanged when no
  class is active).
- `npm run test` is green.

### A trailing `--since` window on the TUI Usage and Failures panes, matching `tumwater report --since` (planned 2026-10-10 by plan; sibling of the landed dashboard Usage/Failures `--since`; completes the CLI's `report --since` / `report --failures --since` on the TUI's two report panes; independent of the waiting `Ctrl+G` scope plan and of the waiting TUI History `--since` plan in its own window state and key — its own `reportWindow`, a different `Ctrl+E` — though it edits the same two Ctrl+T report branches and hintLine region as the `Ctrl+G` plan, so a landing conflict is possible and the resolver handles it; done 2026-10-10 by feature)

**Goal.** `tumwater report --since <duration>` totals usage over a trailing window and
`tumwater report --failures --since <duration>` windows the failure digest, both capped at
`REPORT_SINCE_MAX_MS` (7d), and the dashboard's Usage/Failures tabs now offer the same
1h/6h/1d choice. The TUI's Usage and Failures panes still render only the whole-day shape
(`REPORT_DEFAULT_DAYS`) via `collectReport` / `collectFailureReport`, so the TUI is the one
surface that cannot ask either report for the last hour or day. Add a session-only window cycle,
keyed `Ctrl+E`, that reads through the same `collectReportSince` / `collectFailureReportSince`
collectors and the same Markdown renders the CLI and dashboard use.

**Approach.**
1. `src/ui/tui/tui-keys.ts`: import `collectReportSince` from `../../report/report-data.js`,
   `renderSinceReportMarkdown` from `../../report/report-render.js`, `collectFailureReportSince`
   from `../../failure/failure-data.js`, and `REPORT_SINCE_MAX_MS` from
   `../../events/event-window.js`. Add a module constant `REPORT_WINDOWS:
   ReadonlyArray<[number | null, string]>` = `[[null, "default"], [3_600_000, "1h"],
   [21_600_000, "6h"], [86_400_000, "1d"], [REPORT_SINCE_MAX_MS, "7d"]]`, and two module
   helpers `usagePaneCache(root: string, sinceMs: number | null): string` and
   `failuresPaneCache(root: string, sinceMs: number | null): string`: at `sinceMs === null`
   return the existing day shape (`renderReportMarkdown(collectReport(root,
   REPORT_DEFAULT_DAYS))` / `renderFailureMarkdown(collectFailureReport(root,
   REPORT_DEFAULT_DAYS))`) unchanged; otherwise return
   `renderSinceReportMarkdown(collectReportSince(root, sinceMs))` /
   `renderFailureMarkdown(collectFailureReportSince(root, sinceMs))`. The since renders already
   print their own `window: last <label>` line, so the pane body needs no extra label.
2. Add `let reportWindow: number | null = null` beside the `paneCache` state (session-only, like
   the view/scroll state). In the Ctrl+T handler the Usage branch becomes
   `paneCache = usagePaneCache(root, reportWindow)` and the Failures branch
   `paneCache = failuresPaneCache(root, reportWindow)`. Add a `Ctrl+E` branch beside the Ctrl+N
   branch, gated `!budgetMode && !rolePromptFor` like the other mode-sensitive keys: advance
   `reportWindow` to the next `REPORT_WINDOWS` entry (index-of, `+1` mod length); when
   `view === roleIds.length + 2` (Usage) or `view === roleIds.length + 3` (Failures) recompute
   `paneCache` from the matching helper and reset `paneScroll = 0` so the changed body re-enters
   at its head; always `deps.requestRender()`. Off both report views, setting `reportWindow` is
   enough — the next Ctrl+T entry computes with it.
3. Expose the window on `TuiKeysState` as `reportSince: string | null`, the `REPORT_WINDOWS`
   label for `reportWindow` (null while it is null), and return it from `state()`.
4. `src/ui/tui/tui-frame.ts`: the `TuiView` `usage` and `failures` variants gain
   `window: string | null`. Split the shared
   `usage || failures || history || pending` branch of `hintLine` so `usage`/`failures` get their
   own key list, carrying `["Ctrl+E", view.window ? \`window: ${view.window}\` : "window:
   default"]` before the `Ctrl+T`/`Ctrl+D` pairs (the remaining `history || pending` branch is
   unchanged). `tabStrip` stays as it is (plain `Usage` / `Failures`).
5. `src/ui/tui/tui.tsx`: build the two panes as `{ kind: "usage", window: s.reportSince }` and
   `{ kind: "failures", window: s.reportSince }` from the state it already reads.
6. No new runtime dependency; the role scope (`scopeRole`, the `Ctrl+G` plan) and the History
   pane are untouched, and `paneBody` reads only `paneCache` so it needs no change.

**Files touched.** `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`,
`test/tui-keys.test.ts`, `test/tui-frame.test.ts` (plus the `{ kind: "usage" }` /
`{ kind: "failures" }` literals in `test/tui-frame.test.ts` gain `window: null`).

**Acceptance criteria.**
- `test/tui-keys.test.ts`, a new case: seed one `feature` `tick_end` with tokens 30 min old and
   one 3 days old (both ts derived from one `Date.now()` read), `syncSnapshot(0, false, [])`, then
   Ctrl+T into Usage and press Ctrl+E: `state().reportSince` cycles `"1h"`, `"6h"`, `"1d"`,
   `"7d"`, `null`; under `"1h"` the cached pane carries the 30-min tick's tokens and not the
   3-day tick's, and under `null` it carries both; each press on the Usage view resets
   `paneScroll` to 0. The same cycle on the Failures view with an error-result tick inside the
   hour and one outside. Ctrl+E leaves `reportSince` unchanged while budget mode or role-prompt
   mode holds the prompt line, and pressing it off both report views changes the label without
   recomputing a cache.
- `test/tui-frame.test.ts`: `hintLine({ kind: "usage", window: "1h" }, ...)` carries a `Ctrl+E`
   hint naming `window: 1h`, while `window: null` names `window: default`; the same for
   `failures`; the `{ kind: "usage" }` / `{ kind: "failures" }` literals in the existing
   frame/hint/tab-strip cases become `{ kind: "usage", window: null }` /
   `{ kind: "failures", window: null }` and their assertions are otherwise unchanged.
- The existing Ctrl+T Usage/Failures cache cases stay green (the default window is unchanged).
- `npm run test` is green.

### List the durable land queue in execution order: `tumwater queue [--json]` (planned 2026-10-10 by plan; independent of the waiting TUI Usage/Failures `--since` and CLI history `--result` plans — a new CLI command over `src/landing`, no `src/ui/tui` or `src/history` file; completes the land queue's read surfaces, which today expose its depth in the status header and its entries only through `tumwater status --json`'s `landQueue` object, never as a command of its own; done 2026-10-10 by feature)

**Goal.** The orchestrator's landing slot drains the durable land queue (`src/landing/landing-queue.ts`) oldest-first, but no command lists the waiting landings: `tumwater status` shows only the header depth and `tumwater status --json` buries the entries inside the whole fleet snapshot. Add `tumwater queue [--json]`: every readable entry in execution order (position, loop, tick number, short pinned sha, age, summary), a `land queue empty` line for an empty queue, and a count of the torn/foreign queue files the reader skips.

**Approach.**
1. `src/landing/landing-queue.ts`: add `export interface LandingQueueView { entries: LandingEntry[]; unreadable: number }` and `export function readLandingQueue(root: string): LandingQueueView` — one pass over the private `queueFiles(root)` through the existing `readEntry`, pushing readable entries in filename order and counting the rest. The queue's depth is `entries.length + unreadable`, so no second directory listing is needed. This is the one home of "the queue as a view", beside its readers.
2. `src/status/status-data.ts`: replace the `queuedLandings(root)` read with `readLandingQueue(root)` so the status payload's `landQueue.entries` and the new command cannot drift. Keep the same projection (`{role, sha, tick, summary, enqueuedAt}`) and the `entries?` guard on a non-empty readable list (`view.entries.length > 0`), and use `view.entries` for the `liveLandingMarker` sha set; `depth` becomes `view.entries.length + view.unreadable`. Update the doc comments that name `queuedLandings`.
3. A new render-half module `landing-queue-render.ts` beside `landing-queue.ts` in `src/landing/` (the `change-render.ts`/`backlog-render.ts` convention): `export function renderLandingQueue(view: LandingQueueView, now: number): string` — a `land queue (<depth>):` header then one 1-based line per entry, `  <n>. <role> tick #<tick> · <shortSha(sha)> · <humanSeconds(secondsSince(enqueuedAt, now))> ago · <summary>`; `depth === 0` prints `land queue empty`; `unreadable > 0` appends `  (+<n> unreadable queue file(s) skipped)`.
4. `src/cli/cli-query-commands.ts`: add `export async function cmdQueue(root, args)`: `rejectUnknownArgs("queue", args, [JSON_FLAG])`, `await requireReadyRepo(root)`, then `sayJsonOrRender(args, readLandingQueue(root), (v) => renderLandingQueue(v, Date.now()))`. The `--json` form prints the view's raw `entries` (unshortened `sha`, raw `enqueuedAt`) plus `unreadable`, the `report --json` precedent that the JSON is the collector's own document, not a re-parse of the render.
5. `src/cli.ts`: import `cmdQueue` from `./cli/cli-query-commands.js` and add `case "queue": await cmdQueue(root, args); break;` beside the other read-only query cases.
6. `src/cli/help.ts`: add a `tumwater queue [--json]` stanza beside `tumwater diff` naming the execution order, the per-entry fields, and that `--json` prints the `{entries, unreadable}` document.
7. No new runtime dependency; `status`, `diff`, the landing pipeline, and the TUI/dashboard are otherwise untouched (their depth badge and in-flight cell keep reading the same snapshot fields).

**Files touched.** `src/landing/landing-queue.ts`, a new `landing-queue-render.ts` in `src/landing/`, `src/status/status-data.ts`, `src/cli/cli-query-commands.ts`, `src/cli.ts`, `src/cli/help.ts`, `test/landing-queue.test.ts`, a new `cli-queue.test.ts` in `test/`, `test/help.test.ts`.

**Acceptance criteria.**
- `test/landing-queue.test.ts`, new cases: after three `enqueueLanding` calls with distinct `enqueuedAt` (or the same millisecond, relying on the counter), `readLandingQueue(repo).entries` is in filename order and `unreadable` is 0; a torn file written into `landQueueDir(repo)` (a junk `.json` beside the healthy entries) is skipped by `entries` and counted in `unreadable`; a missing queue directory reads as `{entries: [], unreadable: 0}`.
- A new `cli-queue.test.ts` in `test/` (`cli(repo, ...)` over an initialized repo): an empty queue prints `land queue empty` and exits 0; after two `enqueueLanding` calls, `queue` prints one line per entry oldest-first carrying the loop, `tick #<n>`, the short sha, an age, and the summary; `queue --json` prints `{entries:[...], unreadable:0}` with the raw sha and numeric `enqueuedAt`; an unknown flag exits non-zero naming the flag.
- `test/help.test.ts`: `ALL_COMMANDS` names `queue`, and `helpTopic("queue")` resolves to a stanza starting `  tumwater queue`.
- The existing `status --json` `landQueue` cases and the other `test/landing-queue.test.ts` cases stay green (the readable-entry projection is unchanged).
- `npm run test` is green.

### Filter `tumwater history` by outcome class: `--result <changes|none|problems>` (planned 2026-10-10 by plan; independent of the waiting TUI History `--since`, TUI Usage/Failures `--since`, and TUI `Ctrl+G` scope plans — CLI-only, no `src/ui/tui` file; completes the dashboard History view's outcome filter on the command line, sharing its one bucket rule; done 2026-10-10 by feature)

**Goal.** The dashboard's History view narrows ticks to an outcome class — Changes
(`changed`/`queued`), No change (`no_change`/`skipped`/`user_aborted`), Problems (everything
else, e.g. `error`/`rejected`) — beside its loop picker, text search, and count/window choice.
`tumwater history` has `--role`, `-n`, `--since`, `--grep`, and `--json` but no outcome filter,
so the command line cannot ask "which ticks errored in the last day" (`--grep` matches summary
text, not the result). Add `--result <class>` to the CLI, reading the same bucket rule the
dashboard's `historyClass` applies.

**Approach.**
1. `src/history/history-data.ts`: add `export const HISTORY_RESULT_CLASSES = ["changes",
   "none", "problems"] as const` and `export function historyClass(result: string): "changes"
   | "none" | "problems"` with the dashboard's buckets (`changed`/`queued` → `changes`;
   `no_change`/`skipped`/`user_aborted` → `none`; everything else → `problems`). This is the
   canonical rule; the browser's copy is pinned to it by a test (criterion 2).
2. `src/history/history.ts`: add `export const HISTORY_RESULT_VALUE_ERROR = "history --result
   needs a value"` beside `HISTORY_GREP_VALUE_ERROR`. After `parseGrepFlag` and the
   `--since`/`-n`/`--role` row collection, read `flagValue(rest, "--result")`: `null` → no
   filter; `undefined` or `""` → `fail(HISTORY_RESULT_VALUE_ERROR)`; a value not in
   `HISTORY_RESULT_CLASSES` → `fail` naming the accepted classes (the existing `gotSuffix`
   shape). Apply after the grep filter: `rows = rows.filter((r) => historyClass(r.result) ===
   resultClass)`. `--result` composes with `--role`, `-n`, `--since`, `--grep`, and `--json` —
   no rival-shape rule. Extend the doc comment.
3. `src/history/history.ts` empty state: keep `--grep`'s precedence; when rows are empty and
   `--result` alone is the active filter, print `no ticks with result "<class>"` (the grep
   wording's shape) instead of `no ticks yet`, so a filtered-out set is never read as a quiet
   log. `--json` stays a bare `{rows}` document in every exit-0 case.
4. `src/cli/cli-flag-specs.ts`: add `resultFlagSpec(missingValue)` beside `grepFlagSpec` —
   `{ names: ["--result"], value: true, valueName: "<class>", missingValue }` — so a trailing
   `--result` is refused at the gate with the same wording the body uses.
5. `src/cli.ts`: add `resultFlagSpec(HISTORY_RESULT_VALUE_ERROR)` to the `history` case's
   `rejectUnknownArgs` list, beside `grepFlagSpec`.
6. `src/cli/help.ts`: the `tumwater history` usage line gains `[--result
   <changes|none|problems>]` and its description notes the outcome filter composes with
   `--role`, `--since`, `-n`, and `--grep`.
7. No new runtime dependency; the dashboard's client-side filter and `/api/history` are
   unchanged.

**Files touched.** `src/history/history-data.ts`, `src/history/history.ts`,
`src/cli/cli-flag-specs.ts`, `src/cli.ts`, `src/cli/help.ts`,
`test/cli-history-filtering.test.ts`, `test/cli-history.test.ts`,
`test/gui-client-history.test.ts`.

**Acceptance criteria.**
- `test/cli-history-filtering.test.ts`, new cases against `seededHistoryRepo()` (results
   `changed`, `no_change`, `error`): `history --result changes` prints only feature #7;
   `--result none` only clean #3; `--result problems` only bugfix #9; `--result changes
   --since 1h` composes; `--result problems --json` is `{rows:[the error row]}` with no prose
   or note; `--result bogus` exits 1 naming `changes, none, problems`; a trailing `history
   --result` exits 1 with `history --result needs a value`; a result filter matching nothing
   prints `no ticks with result "<class>"`, never `no ticks yet`.
- `test/gui-client-history.test.ts`: the existing `historyClass` bucket assertion is extended
   to compare the browser function against the shared `historyClass` from `history-data.js`
   over `changed, queued, no_change, skipped, user_aborted, error, rejected`, so the two copies
   cannot drift.
- The existing `--role`, `-n`, `--since`, `--grep`, and `--json` history cases stay green.
- `npm run test` is green.

### A trailing `--since` window in the TUI History pane, matching `tumwater history --since` (planned 2026-10-10 by plan; independent of the waiting dashboard report `--since` and TUI `Ctrl+G` scope plans — different pane, its own window state, a different key; sibling of the landed dashboard History trailing window and the landed `tumwater history --since`; done 2026-10-10 by feature)

**Goal.** `tumwater history --since <duration>` reads a trailing window through `readTickRowsSince`,
and the dashboard's History view offers the same windows (1h/6h/1d/7d). The TUI's History pane
still renders only the newest `HISTORY_DEFAULT_TICKS` ticks via
`readTickRows(root, HISTORY_DEFAULT_TICKS, null)`, so the TUI is the one surface that cannot ask
for the last hour or day. Add a session-only window cycle, keyed `Ctrl+S`, that reads through the
same collector and prints the same sparse-window note the CLI prints.

**Approach.**
1. `src/ui/tui/tui-keys.ts`: import `readTickRowsSince` from `../../history/history-data.js` and
   `SPARSE_WINDOW_NOTE` from `../../events/event-window.js`. Add a module constant
   `HISTORY_WINDOWS: ReadonlyArray<[number | null, string]>` =
   `[[null, "default"], [3_600_000, "1h"], [21_600_000, "6h"], [86_400_000, "1d"], [604_800_000, "7d"]]`,
   and a module helper `historyPaneCache(root: string, sinceMs: number | null): string`:
   when `sinceMs === null` return `historyPaneText(readTickRows(root, HISTORY_DEFAULT_TICKS, null))`
   unchanged; otherwise read `const { rows, covered } = readTickRowsSince(root, sinceMs, null)`,
   return `""` when `historyPaneText(rows)` is empty (so the pane keeps its own empty note),
   and otherwise return `"window: last " + label + "\n" + body` plus, when `!covered`,
   `"\n" + SPARSE_WINDOW_NOTE`.
2. Add `let historyWindow: number | null = null` beside the `paneCache` state (session-only, like
   the view/scroll state). The Ctrl+T handler's History branch becomes
   `paneCache = historyPaneCache(root, historyWindow)`. Add a `Ctrl+S` branch beside the Ctrl+N
   branch, gated `!budgetMode && !rolePromptFor` like the other mode-sensitive keys: advance
   `historyWindow` to the next `HISTORY_WINDOWS` entry (index-of, `+1` mod length); when
   `view === roleIds.length + 4` (History) recompute `paneCache = historyPaneCache(root, historyWindow)`
   and reset `paneScroll = 0` so the changed body re-enters at its head; always
   `deps.requestRender()`. Off the History view, setting `historyWindow` is enough — the next
   Ctrl+T entry computes with it.
3. Expose the window on `TuiKeysState` as `historySince: string | null`, the `HISTORY_WINDOWS`
   label for `historyWindow` (null while it is null), and return it from `state()`.
4. `src/ui/tui/tui-frame.ts`: the `TuiView` history variant becomes
   `{ kind: "history"; since: string | null }`. Split the shared
   `usage || failures || history || pending` branch of `hintLine` so `history` has its own key
   list, carrying `["Ctrl+S", view.since ? \`window: ${view.since}\` : "window: default"]`
   before the `Ctrl+T`/`Ctrl+D` pairs; the `tabStrip` label stays `History`.
5. `src/ui/tui/tui.tsx`: build the pane as `{ kind: "history", since: s.historySince }`.
6. No new runtime dependency; the role scope, Usage/Failures panes, and Pending pane are
   untouched.

**Files touched.** `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`,
`test/tui-keys.test.ts`, `test/tui-frame.test.ts` (plus the `{ kind: "history" }` literals in
`test/tui-history.test.ts` gain `since: null`).

**Acceptance criteria.**
- `test/tui-keys.test.ts`, a new case: seed a `feature` `tick_end` 30 min old and one 3 days old
   (both ts derived from one `Date.now()` read), `syncSnapshot(0, false, [])`, then Ctrl+T into
   History and press Ctrl+S: `state().historySince` cycles `"1h"`, `"6h"`, `"1d"`, `"7d"`,
   `null`; under `"1h"` the cache carries the 30-min row and not the 3-day row, and under `null`
   it carries both; each press on the History view resets `paneScroll` to 0. Ctrl+S leaves
   `historySince` unchanged while budget mode or role-prompt mode holds the prompt line, and
   pressing it off the History view changes the label without computing a cache.
- `test/tui-frame.test.ts`: `hintLine({ kind: "history", since: "1h" }, ...)` carries a `Ctrl+S`
   hint naming `window: 1h`, while `since: null` names `window: default`; the `{ kind: "history" }`
   literals in the existing frame/hint/tab-strip cases become `{ kind: "history", since: null }`
   and their assertions are otherwise unchanged.
- The existing Ctrl+T History cache/paging case stays green (the default window is unchanged).
- `npm run test` is green.


### A trailing `--since` window on the dashboard Usage and Failures views (planned 2026-10-10 by plan; independent of the waiting dashboard History trailing-window and prompt `--edit --attach` plans; completes the CLI's `report --since` and `report --failures --since` on the dashboard's two report tabs, sharing their `windowView` toolbar with the landed role scope; done 2026-10-10 by feature)

**Goal.** `tumwater report --since <duration>` totals usage over a trailing window and
`tumwater report --failures --since <duration>` windows the failure digest the same way (both
capped at 7d). The dashboard's Usage and Failures views offer only whole-day counts
(7/14/30/90 and 7/14/30), so an operator cannot ask either tab for the last hour, 6 hours, or
day — the sub-day windows the CLI has. Add a trailing-window choice to both toolbars that
reads through the same `collectReportSince` / `collectFailureReportSince` collectors and reuses
the CLI's own Markdown render, so the browser and the terminal cannot disagree about the
window or its totals.

**Approach.**
1. `src/gui/gui-endpoints.ts`: import `collectReportSince` from `../report/report-data.js`,
   `renderSinceReportMarkdown` from `../report/report-render.js`, `collectFailureReportSince`
   from `../failure/failure-data.js`, and `REPORT_SINCE_MAX_MS` from `../events/event-window.js`.
   In `handleReport`, after the existing `role` validation, branch on `q.get("sinceMs") !== null`:
   a simultaneous `q.get("days") !== null` is the CLI's rival shape → 400 naming both; otherwise
   parse through the existing `intQuery(q, res, "sinceMs", "positive")` (null → return), reject a
   value above `REPORT_SINCE_MAX_MS` with a 400 naming the cap, and answer
   `{ markdown: renderSinceReportMarkdown(collectReportSince(root, sinceMs, role ?? undefined)) }`.
   The day path is unchanged (`collectReport` JSON). `handleFailures` gets the identical branch,
   answering `{ markdown: renderFailureMarkdown(collectFailureReportSince(root, sinceMs, role ?? undefined)) }`,
   and its day path stays `collectFailureReport` + `renderFailureMarkdown`.
2. `src/ui/gui/gui-client-report.ts`: give `viewHead` an optional trailing `sinceChoices`
   argument (an array of `[ms, label]`) and render one `<button type='button' data-since='<ms>'>`
   per entry into the existing `.seg` after the count buttons. In `windowView` add
   `let sinceMs = o.sinceChoices ? Number(recall(o.sinceKey)) || null : null;`, pass
   `o.sinceChoices` into `viewHead`, call `o.endpoint(days, role, sinceMs)`, and mark both
   controls on every fetch — `markActive($(o.pickerId), "days", sinceMs ? -1 : days)` and
   `markActive($(o.pickerId), "since", sinceMs || -1)` — so exactly one is active. `wireClicks`
   gains a `[data-since]` branch (`sinceMs = Number(b.dataset.since)`, `store(o.sinceKey, String(sinceMs))`,
   fetch) and its `[data-days]` branch clears a live since (`sinceMs = null`, `store(o.sinceKey, "")`)
   before persisting the count. Both configs gain
   `sinceChoices: [[3_600_000, "1h"], [21_600_000, "6h"], [86_400_000, "1d"]]` and
   `sinceKey: "usage-since"` / `"fail-since"`, and their `endpoint` takes `(days, role, sinceMs)`
   to build `/api/report?sinceMs=<ms>` (or `/api/failures?sinceMs=<ms>`) when set, the day
   `?days=` form otherwise, with the role suffix unchanged.
3. Usage's `render(d)`: when the payload carries `d.markdown` (the since shape), render it as
   `"<article class='card md'>" + renderMarkdown(String(d.markdown).replace(/^# .*\n+/, ""), true) + "</article>"`
   — the same markdown-card path Failures already uses, dropping the render's own `# …` heading
   since the view head titles the page — and otherwise keep today's `reportSummary` + chart
   render. Failures' render already handles `{ markdown }` and needs no change.
4. No new runtime dependency; the day-window path and both role scopes are untouched.

**Files touched.** `src/gui/gui-endpoints.ts`, `src/ui/gui/gui-client-report.ts`,
`test/gui-endpoints.test.ts`, `test/gui-report.test.ts`.

**Acceptance criteria.**
- `test/gui-endpoints.test.ts`: `handleReport` with `?sinceMs=3600000` answers 200
  `application/json` with a `markdown` field carrying no `series`/`days`, whose text includes
  `renderSinceReportMarkdown`'s `window: last 1h` line and counts a seeded `tick_end` 30 min old
  but not one 3 h old; `handleFailures` with `?sinceMs=3600000` answers `{ markdown }` whose first
  line is the failure digest's `window: last 1h`. `?sinceMs=604800001` (above the cap) and
  `?sinceMs=3600000&days=7` (rival shape) each answer 400; `?sinceMs=3600000&role=feature` scopes
  both collectors (only the feature tick counts, the digest names `feature`).
- `test/gui-report.test.ts`: with `recall("usage-since")` returning `"3600000"`, `fetchReport`
  requests `/api/report?sinceMs=3600000`, and a `{ markdown }` payload renders through
  `renderMarkdown` in the Usage body instead of the chart path; the built toolbar carries a
  `data-since` button that `markActive` marks while no `data-days` button is active. Choosing a
  `data-days` button builds a `?days=` request (asserted through the URL passed to the injected
  `getJson`).
- The existing day-window `handleReport`/`handleFailures` tests and the Usage chart and
  sparse-note tests stay green.
- `npm run test` is green.

### Role-scoped Usage and Failures panes in `tumwater tui`: the `Ctrl+G` scope cycle (planned 2026-10-10 by plan; independent of the waiting dashboard History trailing-window, dashboard report `--since`, and prompt `--edit --attach` plans; sibling of the landed "Role-scoped Usage and Failures views in the dashboard"; completes the landed `tumwater report --role <id>` / `tumwater report --failures --role <id>` scopes in the TUI's two report panes; done 2026-10-10 by feature)

**Goal.** `tumwater report --role <id>` and `tumwater report --failures --role <id>` scope the day report and failure digest to one loop, and the dashboard's Usage/Failures tabs have the same scope. The TUI's Usage and Failures panes still render fleet-wide and nothing in the pane can narrow them to the loop an operator is investigating, so the TUI is the one surface that cannot answer "what did this loop spend / how did it fail". Add one session-scoped role scope the operator cycles with a single key, applied to both panes through the collectors the CLI and dashboard already share.

**Approach.**
1. `src/ui/tui/tui-keys.ts`: add `let scopeRole: string | null = null` beside the `view` state, with a comment that it is session-only (the view/selection/scroll state is not persisted either), so a fresh TUI starts fleet-wide. Add the `Ctrl+G` branch, gated `!budgetMode && !rolePromptFor` like the other mode-sensitive keys: cycle `scopeRole` through `[null, ...roleIds]` (index-of-then-`+1`-mod-length), and when the current view is the Usage pane (`view === roleIds.length + 2`) or the Failures pane (`view === roleIds.length + 3`), recompute `paneCache` from the scoped collector (below) and reset `paneScroll = 0` so the changed body re-enters at its head; on any other view just set `scopeRole` (the Ctrl+T entry below computes with it). Always `deps.requestRender()`.
2. The Ctrl+T handler's two report branches change to `collectReport(root, REPORT_DEFAULT_DAYS, scopeRole ?? undefined)` and `collectFailureReport(root, REPORT_DEFAULT_DAYS, scopeRole ?? undefined)` — the same role parameter the CLI's `--role` and the dashboard tabs pass.
3. `syncSnapshot` resets `scopeRole` to null when it is not in the incoming `roles` roster (a retired/renamed loop must not leave the panes silently scoped to an absent role), joining the existing stale-`view` clamp; expose `scopeRole` on `TuiKeysState` and in `state()`.
4. `src/ui/tui/tui-frame.ts`: the `TuiView` `usage` and `failures` variants gain `scope: string | null`; `tabStrip` labels the active tab `Usage: <role>` / `Failures: <role>` and the plain `Usage` / `Failures` when the scope is null; `hintLine` for the usage/failures views gains a `["Ctrl+G", scope ? \`scope: ${scope}\` : "scope: fleet"]` pair after the scroll hint, so the key and the current scope are both on screen.
5. `src/ui/tui/tui.tsx`: build the two views as `{ kind: "usage", scope: s.scopeRole }` and `{ kind: "failures", scope: s.scopeRole }` from the state it already reads.
6. No new runtime dependency; the collectors, their Markdown renders, and the History/Pending panes are untouched.

**Files touched.** `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`, `test/tui-keys.test.ts`, `test/tui-frame.test.ts`.

**Acceptance criteria.**
- `test/tui-keys.test.ts`: with `syncSnapshot(0, false, ["feature", "clean"])` and one seeded `feature` `tick_end` (an error result with tokens, so it appears in both the usage report's totals and the failure digest's per-role table), Ctrl+G cycles `state().scopeRole` from `null` to `"feature"` to `"clean"` to `null`; on the Usage view each press recomputes `paneCache`, and the `clean`-scoped cache differs from the fleet-wide one; cycling to the Failures view under the same `clean` scope caches a digest whose text differs from the fleet-wide one; Ctrl+G leaves `scopeRole` unchanged while budget mode or role-prompt mode holds the prompt line; a later `syncSnapshot` whose roster drops the scoped role resets `scopeRole` to null.
- `test/tui-frame.test.ts`: `tabStrip({ kind: "usage", scope: "feature" }, width)` shows `Usage: feature` while `scope: null` shows `Usage`; `hintLine` for a usage or failures view carries the `Ctrl+G` hint, naming `scope: feature` under a scope and `scope: fleet` without one.
- `npm run test` is green.

### `tumwater prompt --edit ... --attach`: add images to a queued prompt in place (planned 2026-10-10 by plan; independent of the dashboard History and citation-sweep series; completes the landed `tumwater prompt --attach` enqueue form, whose doc-comment names the gap; done 2026-10-10 by feature)

**Goal.** `tumwater prompt --attach <path> <text>` queues a prompt with up to four images;
`tumwater prompt --edit <n> "<new text>"` rewrites a queued prompt in place and carries its
existing `[image attached: …]` references over, because `--edit` has no `--attach` form. An
operator who queued the wrong image (or none) must cancel and re-queue, losing the entry's
position and its pending `--at` deferral. Let `--edit` accept `--attach` too, saving the new
images beside the same queue file and appending their reference lines after the existing set,
so one command corrects the text and the images without moving the entry.

**Approach.**
1. `src/cli/cli-command-args.ts`: the edit variant gains `attachPaths: string[]`. `--attach`
   stays queue/edit-only: call `refuseQueueOnlyFlag("--attach", attachFlags.length > 0 && editFlag < 0)`
   so `--list`/`--cancel` keep the exact `--attach only queues a prompt` refusal while `--edit`
   passes. In the `editFlag` branch, claim `attachClaims` alongside `roleClaim` in both token
   scans (the stray-token loop before the position, and the replacement-text loop), so an attach
   pair is never replacement text, and return `attachPaths`.
2. `src/inbox/prompt-commands.ts`: factor the enqueue branch's `--attach` block (the
   `attachPathsProblem` pre-check, the per-path `fs.readFileSync` + base64, and
   `promptImagesProblem`) into one module-level helper `readPromptImages(paths): PromptImageInput[]`
   that fails through `fail`. The enqueue and edit branches both call it; the edit branch passes
   the result to `editRolePrompt`.
3. `src/inbox/inbox-edit.ts`: `editRolePrompt(root, role, position, newText, images?: PromptImageInput[])`.
   After reading the old file and its carried references, when `images` is non-empty: reject a
   combined count above `PROMPT_IMAGES_MAX_COUNT` with
   `promptImagesCountProblem(carried.length + images.length)`, save them with
   `savePromptImages(root, role, file, images)`, and append their `imageReferenceLines` after the
   carried ones. The composed length check (`promptLengthProblem`) then covers the body plus
   every reference line; on any throw after the save, `unlinkAllMissingTolerant` the newly saved
   paths so a failed edit strands no files — the same unwind `submitPromptWithImages` uses.
4. `src/inbox/inbox-attachments.ts` + `src/inbox/inbox.ts`: seed `savePromptImages`'s `taken`
   set from the same-stem image siblings already beside the queue file, so an edit that adds a
   `.png` to a prompt that already has one gets `-2` rather than overwriting the referenced file.
   Extract `inbox.ts`'s inline same-stem test in `removeSameStemSiblings` into an exported
   `isPromptImageSibling(stem, entry)` in `inbox-attachments.ts` and call it from both sites,
   single-homing the `<stem>.<ext>` / `<stem>-<n>.<ext>` shape.
5. `src/cli/help.ts` and `README.md`: name the `--edit … --attach` form beside the enqueue form.
6. No new runtime dependency.

**Files touched.** `src/cli/cli-command-args.ts`, `src/inbox/prompt-commands.ts`,
`src/inbox/inbox-edit.ts`, `src/inbox/inbox-attachments.ts`, `src/inbox/inbox.ts`,
`src/cli/help.ts`, `README.md`, and the tests named below.

**Acceptance criteria.**
- `test/cli-command-args.test.ts`: the `--edit` fixtures carry `attachPaths: []`; a new case
  parses `--edit 1 "new" --attach a.png` (and an `--attach` pair before `--edit`) to
  `{ mode: "edit", …, attachPaths: ["a.png"] }` with the attach pair absent from `text`;
  `--list`/`--cancel` still fail with `--attach only queues a prompt`.
- `test/inbox-edit.test.ts`: `editRolePrompt` with one image writes the new text plus the carried
  and new reference lines under the same queue file and deferral; a second same-extension image
  on a prompt that already has one lands as `<stem>-2.<ext>` while the existing file is
  byte-unchanged; a combined count over four throws before any save; an over-cap composed text
  throws and removes the just-saved image.
- `test/prompt-commands.test.ts`: `prompt --edit 2 --attach <png> "new text"` rewrites the
  entry and `--list` shows both reference lines; the queue keeps its position and stamp; a bad
  attach path fails by name with the queue untouched.
- `test/inbox-attachments.test.ts`: `savePromptImages` returns a non-colliding path when a
  same-stem image already exists.
- `npm run test` is green.

### A trailing window on the dashboard History view, matching `tumwater history --since` (planned 2026-10-10 by plan; sibling of the waiting "Search the dashboard History view with `tumwater history --grep`'s rule" plan — the two touch the same toolbar and fetch path and compose in either landing order; independent of the citation-sweep and invariant-register plans; done 2026-10-10 by feature)

**Goal.** `tumwater history --since <duration>` shows the completed ticks of a bounded trailing window, and marks a sparse window (one whose oldest retained event sits inside it) with the shared note. The dashboard's History view offers only a tick count, so an operator cannot ask "what happened in the last day" from the browser. Add a trailing-window choice to the toolbar that reads through the same `readTickRowsSince` collector the CLI uses, so the two views cannot disagree about the window's rows or its sparse-window warning.

**Approach.**
1. `src/gui/gui-endpoints.ts` `handleHistory`: read `role` as today, then branch on `q.get("sinceMs")`. Absent `sinceMs` leaves the `n` path unchanged (`{ rows }`). Present: a simultaneous `n` is a rival shape → 400 naming both, the CLI's count-vs-window rule; otherwise parse through `intQuery(q, res, "sinceMs", "positive")`, reject a value above `LOGS_SINCE_MAX_MS` (imported from `../events/event-window.js`, the same cap `history --since` uses) with a 400 naming the cap, and answer `{ rows, covered, note }` from `readTickRowsSince(root, sinceMs, role)` — add that import from `../history/history-data.js` — where `note` is `SPARSE_WINDOW_NOTE` (also from `event-window.ts`) when `!covered` and `""` otherwise. Reads files directly, like today.
2. `src/ui/gui/gui-client-history.ts`: inside the `history-table` region add `HIST_WINDOWS` (`{ "1h": [3_600_000, "the last hour"], "6h": [21_600_000, "the last 6 hours"], "1d": [86_400_000, "the last day"], "7d": [604_800_000, "the last 7 days"] }`) and a pure `historyQuery(count, role, sinceKey)` returning `/api/history?sinceMs=<ms>` (or `n=<count>` when no window) plus `&role=` when a role is set. Add the four options to the existing `#histcount` select after the counts; its value is `histSinceKey || String(histCount)`; choosing a window sets and persists a new `histSinceKey` (`recall("hist-since")`), choosing a count clears it and persists `hist-n` as today. `fetchHistory` calls `getJson(historyQuery(histCount, histRole, histSinceKey))` and keeps the server's `covered`/`note` in state, which `renderHistory` shows above the table when the note is non-empty.
3. The empty state names the active window (`No ticks in the last day`) instead of `No ticks yet`; this joins the sibling search plan's `No ticks match this search` rule, with a set search pattern winning over an empty window, so the note distinguishes "no rows exist in this window" from "rows exist but the search filtered them out".
4. No new runtime dependency.

**Files touched.** `src/gui/gui-endpoints.ts`, `src/ui/gui/gui-client-history.ts`, `test/gui-server.test.ts`, `test/gui-client-history.test.ts`.

**Acceptance criteria.**
- `test/gui-server.test.ts` extends the `/api/history` test: `?sinceMs=<wide>` returns the rows `readTickRowsSince(root, sinceMs, null)` yields with `covered: true` and `note: ""`; `?sinceMs=<tiny>` returns `{ rows: [], covered: true, note: "" }`; `?sinceMs=604800001` (above the cap) and `?sinceMs=3600000&n=20` each 400; `?sinceMs=<wide>&role=clean` returns only that loop's rows.
- `test/gui-client-history.test.ts` runs `historyQuery` through `clientScope` and asserts `sinceMs=` with no `n` in window mode, `n=` with no `sinceMs` otherwise, and `role=` only when set; and asserts the `#histcount` toolbar markup carries the four window options.
- The History view's empty state names the selected window, and the server's sparse note renders when `covered` is false.
- `npm run test` is green.

### Search the dashboard History view with `tumwater history --grep`'s rule (planned 2026-10-10 by plan; independent of the citation-sweep series; sibling of the landed `tumwater history --grep` and the landed role scope in the dashboard History view; done 2026-10-10 by feature)

**Goal.** `tumwater history --grep <text>` filters rows case-insensitively against a canonical
haystack (the row's own unpadded line prefixed with `tick_end`). The dashboard's History view
offers a loop picker and an outcome filter but no text search, so an operator cannot ask the same
substring question from the browser. Add a search field to the History toolbar that filters
through the same rule, with the predicate shared by the CLI and the endpoint rather than
re-implemented in the browser.

**Approach.**
1. `src/history/history-data.ts`: add and export `tickRowGrepHaystack(row: TickRow): string` — the
   canonical unpadded row line (`[row.time, row.loop, \`#${row.tick}\`, row.result,
   row.durationMs === null ? "—" : shortSpanPhrase(row.durationMs), row.usage, row.detail].join("  ").trimEnd()`)
   prefixed `tick_end `, the same string `src/history/history.ts`'s private `grepHaystack` builds
   today through `renderRow(row, widthsOf(cellsOf(row)))`. Import `shortSpanPhrase` from
   `../text/phrases.js` (history.ts already does).
2. `src/history/history.ts`: delete the private `grepHaystack` and have `cmdHistory` filter with
   `tickRowGrepHaystack`, so the CLI and the endpoint share one rule. No behavior change: the
   produced string is byte-identical (each cell padded to its own measured width is unpadded, and
   `cellsOf` already phrases the duration the same way).
3. `src/gui/gui-endpoints.ts` `handleHistory`: read `q.get("grep")`, and when it is non-empty
   filter the `readTickRows` result with the shared predicate lowercased, preserving the CLI rule
   that `n`/`role` bound the scanned rows and grep filters after them (`n` bounds the window, not
   the printed rows). An empty or absent `grep` filters nothing; `role` and `grep` compose.
4. `src/ui/gui/gui-client-history.ts`: add a search `<input id='histgrep'>` to the toolbar, with
   state `histGrep` recalled via `recall("hist-grep")` and persisted via `store`, and append
   `&grep=` (through `encodeURIComponent`) to the `/api/history` URL in `fetchHistory` only when
   non-empty; an Enter/`change` refetches. Pass `histGrep` to `historyTableHtml`, which shows
   `No ticks match this search` (instead of `No ticks yet`) when a pattern is set and the fetched
   rows are empty.

**Files touched.** `src/history/history-data.ts`, `src/history/history.ts`,
`src/gui/gui-endpoints.ts`, `src/ui/gui/gui-client-history.ts`, and the tests named below. No new
runtime dependency.

**Acceptance criteria.**
- `test/history-data.test.ts` pins `tickRowGrepHaystack` as the exact string a row renders as when
  it is the widest in each column (a null-duration row included, its em dash kept), and
  `test/cli-history-filtering.test.ts` still passes unchanged, proving the CLI's `--grep` output is
  untouched.
- `test/gui-server.test.ts` covers `/api/history?grep=<text>`: a pattern matching one seeded row
  returns only it; a pattern matching none returns `{ rows: [] }`; `role` and `grep` compose; `n`
  still bounds the scanned window before grep.
- `test/gui-client-history.test.ts` asserts the search input is in the toolbar, that `fetchHistory`
  appends the encoded `grep` only when set, and that a set pattern with no rows names the search
  rather than the empty log.
- `npm run test` is green.

### Keep the invariant register honest with a citation and id guard test (planned 2026-10-10 by plan; independent of the citation-sweep and Agent backends series; follow-up to the landed "An invariant register"; done 2026-10-10 by feature)

**Goal.** `docs/invariants.md` promises in its own "Keep it honest" paragraph that every invariant
has a stable id and a resolvable `test/...` citation, and that its `Binds.` modules are the ones the
guarantee spans — but nothing enforces any of that. A renamed test, a moved module, or a copied
entry slips through silently, turning the register the fleet reads into a stale citation. Add a test
that parses the register and fails on a broken citation, a duplicate/malformed id, or an entry
missing a field.

**Approach.**
1. Add a new test file, the invariants-doc guard, beside the other doc-parsing tests. Read the register through
   `fileURLToPath(new URL("../../docs/invariants.md", import.meta.url))` (the pattern
   `test/backlog-structure.test.ts` uses for `PLANS.md`), with the repo root as
   `fileURLToPath(new URL("../../", import.meta.url))`.
2. Parse with a small helper local to the test: split the text at `^### (INV-[A-Z]\d+):`, and per
   entry record its id, whether it carries the `**Guarantee.**`, `**Binds.**`, and `**Pinned by.**`
   field labels, and every backticked path token matching `/(?:src|test|docs|plans|scripts)\//`.
3. Assert, so the guard names the failure rather than only a count:
   - the register holds at least one entry, and ids are unique and match `/^INV-[A-Z]\d+$/`;
   - every entry has all three field labels and its `**Pinned by.**` cites at least one
     `test/*.test.ts` path;
   - every cited path resolves under the repo root (skip the prose placeholders — the bare
     `test/...` / `src/...` ellipses and any glob token — so only real citations are checked);
   - the two `test/...` and `src/...` paths cited by each entry exist.
4. Tests only; no `src/` change, no runtime dependency, no new pipeline step.

**Files touched.** One new test file under `test/` (the invariants-doc guard). No source change.

**Acceptance criteria.**
- `npm test invariants` is green, and the new file fails if a cited `test/...` or `src/...` path is
  removed, if two entries share an id, or if an entry loses a field label (verified by temporarily
  breaking the doc and watching the guard fail).
- `docs/invariants.md` is unchanged by this landing and still parses under the new guard.
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 5f/5: `parallel-work-instances`, `worktree-pool` (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 5/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/parallel-work-instances.md` and
`plans/worktree-pool.md`. Both are inventoried over their full text so a path or line pin that
moved is caught rather than missed.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to these two files.

**Files touched.** Those two `plans/*.md` files. No source or test change.

**Acceptance criteria.**
- The inventory over these two files reports no cited path absent from the tree.
- No `<path>:<line>` in them names a line past that file's end.
- For each split module cited here, the module named beside a symbol exports it (checked against
  the module's export list).
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 5e/5: `telemetry-role`, `disk-floor` (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 5/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/telemetry-role.md` and
`plans/disk-floor.md`. `plans/telemetry-role.md` carries the most absent tokens left in the
sweep — the `failure-report` module split across its root and UI homes and its test file, the
moved top-level `loop`, `config`, and `state` modules, and two out-of-range `src/roles/roles.ts`
pins.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to these two files.

**Files touched.** Those two `plans/*.md` files. No source or test change.

**Acceptance criteria.**
- The inventory over these two files reports no cited path absent from the tree.
- No `<path>:<line>` in them names a line past that file's end.
- For each split module cited here, the module named beside a symbol exports it (checked against
  the module's export list).
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 5c/5: `refusal-and-thrash`, `merge-queue`, `work-ratio` (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 5/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/refusal-and-thrash.md`,
`plans/merge-queue.md`, and `plans/work-ratio.md`. `plans/refusal-and-thrash.md` carries the bulk
here: the same moved top-level `pi-stream`, `loop`, `git`, `pi`, `types`, and `config` modules.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to these three files.

**Files touched.** Those three `plans/*.md` files. No source or test change.

**Acceptance criteria.**
- The inventory over these three files reports no cited path absent from the tree.
- No `<path>:<line>` in them names a line past that file's end.
- For each split module cited here, the module named beside a symbol exports it (checked against
  the module's export list).
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 5d/5: `repair-traces`, `revise-rejected` (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 5/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/repair-traces.md` and
`plans/revise-rejected.md`. `plans/repair-traces.md` carries the moved top-level `loop` module and
two out-of-range pins (`src/roles/roles.ts`, `test/prompt.test.ts`); `plans/revise-rejected.md` is
inventoried as well so a later move there is caught.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to these two files.

**Files touched.** Those two `plans/*.md` files. No source or test change.

**Acceptance criteria.**
- The inventory over these two files reports no cited path absent from the tree.
- No `<path>:<line>` in them names a line past that file's end.
- For each split module cited here, the module named beside a symbol exports it (checked against
  the module's export list).
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 5a/5: `plans/agent-backends.md` (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 5/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/agent-backends.md` — the largest
remaining document. Its path tokens all resolve today, but its citations predate the pi-facade,
config, and agent splits, so the split-aware symbol check carries the work.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5.

**Files touched.** `plans/agent-backends.md`. No source or test change.

**Acceptance criteria.**
- The inventory over `plans/agent-backends.md` reports no cited path absent from the tree.
- No `<path>:<line>` in it names a line past that file's end.
- For each split module cited there (e.g. `src/pi/pi.ts`, `src/config/model-selector.ts`), the
  module named beside a symbol exports it (checked against the module's export list).
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 5b/5: `commit-bodies`, `refusal-and-thrash`, `user-defined-loops`, `principles` (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 5/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/commit-bodies.md`,
`plans/refusal-and-thrash.md`, `plans/user-defined-loops.md`, and `plans/principles.md`. The
inventory here flags the moved top-level `loop`, `pi`, `types`, `config`, `git`, and `pi-stream`
modules, plus the moved `commit-bodies` test file cited by `plans/commit-bodies.md`.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to these four files.

**Files touched.** Those four `plans/*.md` files. No source or test change.

**Acceptance criteria.**
- The inventory over these four files reports no cited path absent from the tree.
- No `<path>:<line>` in them names a line past that file's end.
- For each split module cited here, the module named beside a symbol exports it (checked against
  the module's export list).
- `npm run test` is green.

### Role-scoped Usage and Failures views in the dashboard (planned 2026-10-10 by plan; independent of the Agent backends series; sibling of the landed `tumwater report --role <id>` and `tumwater report --failures --role <id>`; completes the CLI's role scope on the dashboard's two report tabs; done 2026-10-10 by feature)

**Goal.** The dashboard's Usage and Failures views gain a loop picker, and `/api/report` and
`/api/failures` accept a `?role=<id>` scope, so an operator can see one loop's spend and one
loop group's failure evidence in the browser without dropping to `tumwater report --role`. The
CLI already scopes both shapes (`report --role`, `report --failures --role`) and the collectors
already take the optional base role (`collectReport(root, days, role?)`,
`collectFailureReport(root, days, role?)`); only the dashboard's endpoint adaptation and its
two views are missing. Out of scope: the TUI's Usage/Failures panes (a separate surface, left
for a later sibling), and any change to the collectors or the CLI.

**Approach.**
1. **Endpoints.** In src/gui/gui-endpoints.ts, `handleReport` and `handleFailures` read
   `const role = q.get("role")` and, when present (`!== null`), validate it through the
   existing `rejectBadRole(root, res, role)` (gui-args.ts) before collecting — absent means the
   fleet-wide report exactly as today, `?role=bogus` gets the shared unknown-role 400 with its
   typo hint, and `?role=` (empty) is a present-but-unknown 400. Then pass `role ?? undefined`
   as the collectors' third argument. No new gui-args helper is needed.
2. **Role picker in the shared view scaffold.** In src/ui/gui/gui-client-report.ts,
   `windowView(o)` gains an optional role scope: a `let role = recall(o.roleKey) || ""`, a
   `rolePickerId`, and an `endpoint(days, role)` that appends `&role=` + encodeURIComponent(role)
   only when `role` is non-empty. `viewHead` gains the picker markup, reusing the History view's
   shape (src/ui/gui/gui-client-history.ts's `#histrole`):
   `<label><span class='sr-only'>Loop</span><select class='field' id='<rolePickerId>'>…</select></label>`
   with an `All loops` empty option. `syncReportRoles(d)` (new, in a `// report-role:start/end`
   region) derives the option list from `(d.loops || []).map((l) => l.role)` — the same list
   `syncHistoryRoles` uses — and is called from `fetchView` after the panel is built and from
   gui-client-boot.ts's status refresh when `activeView` is `"usage"` or `"failures"` (mirroring
   the existing `if (activeView === "history") syncHistoryRoles(d);`). `wireClicks` gains a
   `change` delegate on the panel for `[data-role]` selects that stores the choice
   (`store(o.roleKey, role)`) and refetches. The pure option builder is a separately extracted
   function (e.g. `reportRoleOptions(roles)` returning the `<option>` inner HTML) so it is
   unit-testable without a DOM.
3. **Wire the two views.** The `usage` and `failures` `windowView` calls set the role config and
   the scoped endpoint; the Usage blurb keeps its wording for the fleet-wide case.
4. **Scoped Usage render.** `reportSummary(d)` must not show the fleet-only fleet-wide backlog
   tallies as the scoped role's: when `d.role` is set, drop the `Features done` and `Bugs fixed`
   tiles and, in the `render` output, print one scope line naming `d.role` and stating that
   landing runs and backlog tallies are fleet-wide and omitted. The Failures view needs no
   render change: `renderFailureMarkdown` already emits its `role:` line for a scoped digest.

**Files touched.**
- src/gui/gui-endpoints.ts (`handleReport`, `handleFailures`: read + validate `?role=`, pass it)
- src/ui/gui/gui-client-report.ts (`windowView` role config, `viewHead` picker,
  `reportRoleOptions`, `syncReportRoles`, `wireClicks` change delegate, `reportSummary` scope,
  usage/failures endpoints)
- src/ui/gui/gui-client-boot.ts (sync on status refresh while a report view is open)

Tests: test/gui-report.test.ts — `/api/report?role=feature` deep-equals
`collectReport(repo, 14, "feature")`, `/api/failures?role=feature` equals
`renderFailureMarkdown(collectFailureReport(repo, 14, "feature"))`, `?role=bogus` is a 400 naming
the valid ids, and the page-level endpoint regexes are updated to the role-aware form;
test/gui-client-report.test.ts — a new `report-role` extraction test over `reportRoleOptions`
(the `All loops` empty option, one escaped option per loop, order preserved; a role name with
HTML metacharacters is escaped).

**Acceptance criteria.**
- `/api/report?role=feature&days=14` and `/api/report?role=feature` serve
  `collectReport(root, days, "feature")` — `role: "feature"`, only feature per-role maps,
  zero `featuresDone`/`bugsFixed`; without `?role` the payload is unchanged (seen by the
existing deep-equal against `collectReport(repo, 14)`).
- `/api/failures?role=feature` serves `renderFailureMarkdown(collectFailureReport(root, days,
  "feature"))` and its markdown carries the `role: feature` line; without `?role` it is
  unchanged.
- `?role=bogus` on either endpoint is a 400 whose message names the valid ids; `?role=` is a
  400 too; the days window still clamps exactly as today regardless of `role`.
- The Usage and Failures views render a `Loop` select with `All loops` plus one option per
  `lastStatus.loops[].role`; choosing one refetches with `&role=`, persists through `store`, and
  the Usage summary then omits the `Features done`/`Bugs fixed` tiles and prints the scope line;
  choosing `All loops` returns to the fleet-wide view.
- The options follow the fleet's role list (custom loops included), refreshed while the view is
  open, and a persisted role the fleet no longer lists falls back to `All loops`.
- `npm run test` is green.

### Agent backends, part 7b/7: the claude tool-call stall threshold (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 7/7, which feature judged too large for one run; requires parts 6a/7 and 6b/7 landed; siblings 7a/7 and 7c/7; independent of the citation-sweep series; done 2026-10-10 by feature)

Design: plans/agent-backends.md "Watchdogs and progress". Sibling 7a/7 wires the API cap and
its handback; this part touches neither budget nor argv.

**Goal.** A claude tool call that sends no content update is judged stalled at
`bufferedCommandStallMs`, not `toolCallStallSeconds`, so long verification commands stop crying
wolf (BUGS.md 2026-09-28's lesson); pi keeps today's per-command classification.

**Approach.** The run's backend is already known on both surfaces: runAgent holds `backend.id`
(src/agent/run-agent.ts) and the `tumwater_run` marker carries `agent`, which
src/ui/progress-data.ts reads into `LiveProgress` (`agent?: string`).
- The claude stream must actually expose the call while the tool runs:
`claudeTranslator` (src/agent/claude/claude-stream.ts) now emits a canonical
`tool_execution_start` the moment a `tool_use` block is folded, not at the later `tool_result`
(the two previously arrived together, so no open-call tracker ever saw a claude call).
- runPi's warning: `startPiWatchdogs` (src/pi/pi-watchdogs.ts) — its openToolCalls loop currently
calls `commandBuffersOutput(call.command || call.label)` to pick the buffered threshold. The
deps carry the run's backend id; when it is `"claude"`, every open call takes the
`bufferedCommandStallMs` branch.
- progress-data's flag: `stalledToolLabel` (src/ui/progress-data.ts) does the same classification
for the role's state cell; it reads the current run's `agent` off `LiveProgress` (set from the
marker, preserved across the run's `session` reset, defaulting to pi when no marker precedes the
run) and applies the same rule, so the state cell and the event feed agree on "stalled".

**Files touched.** src/pi/pi-watchdogs.ts, src/ui/progress-data.ts, src/agent/run-agent.ts (feed
the backend id), src/agent/claude/claude-stream.ts (open the call at the `tool_use` block).
Tests: test/pi.test.ts, test/progress.test.ts, test/claude-stream.test.ts.

**Acceptance criteria.**
- A claude Bash call open longer than `toolCallStallSeconds` but shorter than
`bufferedCommandStallMs` raises no stall warning on either surface.
- The same call open past `bufferedCommandStallMs` raises the stall warning on both surfaces.
- A pi non-buffered call still warns at `toolCallStallSeconds`.
- `npm run test` green.

### An invariant register: state each subsystem's guarantees where a fixer can read them (planned 2026-10-10 by steward; promoted from the `unclear-invariant` validation gap, carried by 92 Fixed entries — the largest gap tag and mostly in entries still kept verbatim; independent of the Agent backends and citation-sweep series; done 2026-10-10 by feature)

**Goal.** Retire the `unclear-invariant` gap. It is recorded when a fixer could not confirm a bug
until first reconstructing what the code was supposed to guarantee; today that guarantee lives only
in scattered tests and the fixer's head, so each entry spent effort rediscovering it. Give the
project one place that states its invariants, and point the loops at it before they reconstruct one.

**Evidence.** `unclear-invariant` is the top validation-gap tag by a wide margin — 92 Fixed entries
carry it versus 58 for the next non-`none` tag (`no-observability`) — and unlike the historical tags it is not
mostly compressed: 78 of the 92 are entries still kept verbatim in `## Fixed`. (`grep -oE
'gap:[*]{0,2} ?[a-z-]+' BUGS.md | sed -E 's/^gap:[*]{0,2} ?//' | sort | uniq -c` counts both forms.)
The recurring families, each visible in the cited entries:
- **Two surfaces deriving one fact separately** — the dashboards' stall flag versus the event feed's
  warning ("The dashboards' stall flag never got the piped-stdout exemption…", fixed 2026-09-28),
  the `status` header badge versus the event log's window contract ("The status header's `main
  <sha>: green` badge reads only the default 200-event tail…", fixed 2026-09-29), doctor's binary
  check versus the startup gate's `agentsInUse` ("`checkAgentBinary` always checks pi…", fixed
  2026-10-10), and a kept free tier versus its pre-cap resolution ("The budget-fallback view's kept
  free subscription claude tier dropped the ambient thinking level from its selector…", fixed
  2026-10-10).
- **A reader and writer over one appended or persisted file** that must agree on its end — the
  trailing-fragment window fold, and `slots.json`'s non-finite-timestamp boundary ("`slots.json`'s
  `pinnedAt` and `lastReleasedAt` carried a hand edit's non-finite timestamps…", fixed 2026-10-09).
- **Sibling result shapes a classifier must treat alike** — the loss ranking's `main_red`, `aborted`,
  `review_error`, and `merge_conflict` arms ("The failure digest's loss ranking drops the
  error-class hours a `merge_conflict`/`merge_blocked` landing reprices…", fixed 2026-10-10).
Seed the register from these families, and add sections as new ones recur.

**Approach.**
1. Add a new invariants register under `docs/`: grouped by the boundary an invariant binds. Each entry gets a
   stable id, a one-sentence guarantee, the modules and surfaces it binds, and the `test/...`
   case(s) that pin it. Start from the three families above, seeded from the cited Fixed entries.
2. Point the loops at it. The role prompt already injects `PRINCIPLES.md` through `readPrinciples`
   (src/prompt/principles.ts); name the register there as the place a fixer reads its
   subsystem's guarantees before reconstructing one, so the reference costs a line of prefill rather
   than inlining the whole register.
3. Keep it honest. A landing that adds or changes a guarantee updates the register in the same
   commit; each invariant cites the test that pins it, so a stale invariant is a visible broken
   citation rather than silent drift.
4. No new runtime dependency and no change to the loop pipeline.

**Files touched.** a new invariants register under `docs/`; the role prompt text (src/prompt/principles.ts or the
prompt builder) to name it; the `test/...` cases it cites are unchanged. Doc-only otherwise.

**Acceptance criteria.**
- The register states at least the three boundary families above, each with a stable id, the
  modules/surfaces it binds, and a resolvable `test/...` citation.
- Every `test/...` path the register cites exists and pins the invariant it is cited for.
- The role prompt names the register without inlining it; `PRINCIPLES_MAX_CHARS` is unaffected.
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 3/5: the budget and model plan documents (planned 2026-10-10 by plan; split 2026-10-10 by plan from the single-entry sweep; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for the plan documents that cite the config
and model splits: `plans/daily-cost-budget.md`, `plans/fallback-model.md`, and
`plans/model-tiers.md`.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to these three files. Their absent paths are the `types`, `config`, `loop`,
`orchestrator`, `pi`, `state`, and `status` module moves, so the split-aware map is exercised
across several owners.

**Files touched.** Those three `plans/*.md` files. No source or test change.

**Acceptance criteria.**
- The inventory over these three files reports no cited path absent from the tree.
- No `<path>:<line>` in these three files names a line past that file's end.
- For each split module cited here, the module named beside a symbol exports it (checked against
  the module's export list).
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 4/5: the observer, QA, questions, review, and steward plan documents (planned 2026-10-10 by plan; split 2026-10-10 by plan from the single-entry sweep; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/observer-roles.md`,
`plans/qa-role.md`, `plans/questions-outbox.md`, `plans/review-gate.md`, and
`plans/steward-role.md`.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to these five files. Their absent paths are the `loop`, `types`, `config`,
`orchestrator`, `state`, `questions`, and `status-render` module moves, and
`plans/observer-roles.md` also carries one out-of-range pin.

**Files touched.** Those five `plans/*.md` files. No source or test change.

**Acceptance criteria.**
- The inventory over these five files reports no cited path absent from the tree.
- No `<path>:<line>` in these five files names a line past that file's end.
- For each split module cited here, the module named beside a symbol exports it (checked against
  the module's export list).
- `npm run test` is green.

### Agent backends, part 7c/7: the opt-in `smoke:claude` live check (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 7/7, which feature judged too large for one run; requires parts 6a/7 and 6b/7 landed; siblings 7a/7 and 7b/7; independent of the citation-sweep series; done 2026-10-10 by feature)

Design: plans/agent-backends.md "Testing". Siblings 7a/7 and 7b/7 cover the cap and the stall
threshold; this part is the live check only and changes no production path.

**Goal.** A machine with a logged-in claude can run one opt-in command that exercises the live
CLI end to end, so a regression the fake shim cannot see fails here by hand and not in the fleet.

**Approach.** Add a new `smoke-claude` Node ESM script under `scripts/` (no dependencies) and a
`"smoke:claude"` entry in package.json that runs it. The script builds a
throwaway git repo under `fs.mkdtemp` and drives the real `claude` on PATH, printing a named
PASS/FAIL per check and exiting nonzero on the first failure:
- one call on each default model (Haiku, Sonnet, Opus 5.5), so a CLI too old for one fails here;
- an isolated three-turn run that fails if total cost exceeds $0.10 (the isolation regression);
- a `--resume` of that session;
- a SIGTERM mid-tool call followed by a resume;
- an unknown-model run that must classify as `configError`;
- a check that the observed `billing` matches `claude auth status`, and that
`claude-account.json` gained a window reading when the billing is subscription.
It must not run under `npm test` (it costs money and needs auth): keep the script's own env
setup, and leave `test-runner.ts`'s `TUMWATER_CLAUDE_BIN`/`CLAUDECODE`/`CLAUDE_CODE_*` stripping
as is. Document it in README.md as opt-in.

**Files touched.** a new `smoke-claude` script under `scripts/`, package.json, README.md.

**Acceptance criteria.**
- `npm run smoke:claude` is defined and is referenced nowhere in the `npm test` path; `npm run
test` stays green on a machine with no claude installed.
- Each check prints a named PASS/FAIL and the script exits nonzero on failure.
- On a logged-in machine the script passes; run it once by hand and record the result in the
landing commit body.
- `npm run test` green.

**Landed.** `scripts/smoke-claude.mjs` drives the real CLI through the compiled adapter
(`runAgent`), with a version floor check added before the model calls. The isolation check
prompts for three Bash calls and asserts `costUsd < 0.10` and `turns >= 2` (the second turn is
where the regression loaded `~/.claude`); it ran green by hand against claude 2.1.295 on a
claude.ai subscription. The account check folds the run through `observeClaudeAccount` and
reads the window back.

### Finish the stale code-path citation sweep, part 2c/5: `plans/portability.md`, part 7/7 (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 2/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/portability.md`'s "7/7 — Adopt an
existing repository without hijacking its README" section.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to this section. It cites the config and merge splits, so the split-aware map
and its per-citation symbol check carry most of the work.

**Files touched.** `plans/portability.md` (only the named section). No source or test change.

**Acceptance criteria.**
- The inventory over the named section reports no cited path absent from the tree.
- No `<path>:<line>` in the named section names a line past that file's end.
- For each split module cited in the named section, the module named beside a symbol exports it
  (checked against the module's export list).
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 2b/5: `plans/portability.md`, part 6/7 (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 2/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/portability.md`'s "6/7 — Make the
project's verification command configurable" section.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to this section. This is the densest source of line pins past a file's end in
the sweep, so the inventory step carries most of the work.

**Files touched.** `plans/portability.md` (only the named section). No source or test change.

**Acceptance criteria.**
- The inventory over the named section reports no cited path absent from the tree.
- No `<path>:<line>` in the named section names a line past that file's end.
- For each split module cited in the named section, the module named beside a symbol exports it
  (checked against the module's export list).
- `npm run test` is green.

### Agent backends, part 7a/7: API per-run cap and the `budgetCapped` handback (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 7/7, which feature judged too large for one run; requires parts 6a/7 and 6b/7 landed; siblings 7b/7 and 7c/7; independent of the citation-sweep series; done 2026-10-10 by feature)

Design: plans/agent-backends.md "Billing" (API runs) and §10. Siblings: 7b/7 wires the claude
stall threshold, 7c/7 adds the opt-in smoke script; this part touches neither.

**Goal.** An API-billed, non-director claude run can never overshoot the daily cap, and a run
cut off by `error_max_budget_usd` keeps its worktree and resumes as a `handoff`.

**Approach.**
- Thread the cap to the argv. `ClaudeArgOptions.maxBudgetUsd` and the `--max-budget-usd` builder
already exist in src/agent/claude/claude-args.ts; the missing links are the carrier and the
caller. Add an optional `maxBudgetUsd` to `PiRunOptions` (src/pi/pi.ts) and to `AgentRunSpec`
(src/agent/agent-backend.ts), and have `claudeBackend.invocation`
(src/agent/claude/claude-backend.ts) forward it. Compute the value in the authoring-call wiring
that already holds `root`, the role, and the live loop states — `LoopPi.loopPiOpts`
(src/loop/loop-pi.ts) fed from the tick wiring (src/loop/loop-tick.ts) — using
`readClaudeAccount(root)` (src/agent/claude/claude-account.ts) and `fleetDailyCost` / `dailyCost`
(src/budget/budget.ts). Pass a cap only when the resolved backend is claude and the account
reports `billing: "api"`; it is `maxDailyCostUsd − fleetDailyCost`, lowered to the role's
remaining `maxDailyCostUsdPerRole[role] − dailyCost(roleState)` when that key is set. The
director (`DIRECTOR_ROLE`) and subscription-billed runs pass none.
- Handle the cap hit. `PiRunResult.budgetCapped` is already set by the claude translator
(src/agent/claude/claude-stream.ts, `error_max_budget_usd`). Nothing consumes it today. On an
authoring result with `budgetCapped`, keep the worktree and set `state.resumePending` with a new
`resumeCause` (e.g. `"budget-capped"`) added beside the existing union in
src/loop/loop-state.ts and src/tick/tick-outcome.ts. `planTickStart` (src/tick/tick-resume.ts)
only considers a handoff when `resumePending` is set, so this is what makes the next tick resume
rather than reset the worktree; the handoff then gets the revision/conflict notes, no re-apply,
the leased slot, and the same loop id, exactly as the part 3/7 handoffs do. The existing
`budget-resumed` cause (src/loop/loop-recovery.ts, the mid-tick budget reopen) is unchanged; the
bridge prompt names the new cause distinctly.
- A run with no `result` records cost 0 and logs `cost_unknown`: confirm the translator/run-agent
already emit it (parts 3 and 6a) and add only the missing wiring if a gap is found — do not
rewrite it.

**Files touched.** src/pi/pi.ts, src/agent/agent-backend.ts,
src/agent/claude/claude-backend.ts, src/loop/loop-pi.ts, src/loop/loop-tick.ts,
src/loop/loop-state.ts, src/tick/tick-outcome.ts, src/tick/tick-resume.ts. Tests:
test/claude-args.test.ts and a loop test for `budgetCapped` → handoff.

**Acceptance criteria.**
- On API billing, with $12 of a $15 fleet cap spent and no per-role cap, an authoring claude
run's argv carries `--max-budget-usd 3`; a subscription-billed run's and the director's argv
carry no `--max-budget-usd`.
- With `maxDailyCostUsdPerRole[role] = 2` and $1.50 of the role's spend, the argv carries
`--max-budget-usd 0.5` (the role's remaining is lower than the fleet's remaining).
- A `budgetCapped` authoring result sets `resumePending` and leaves the worktree edits in place;
the next tick runs as `handoff` with the budget-capped cause.
- `npm run test` green.

**Landed 2026-10-10 by feature.** `PiRunOptions` lives in src/agent/run-agent.ts (src/pi/pi.ts
re-exports the type), and the budget-capped verdict arm is in src/tick/tick-verdict.ts rather
than the plan-named src/loop/loop-tick.ts; the cap is computed in `LoopPi.loopPiOpts` from
the persisted loop states, and the forced handoff lives in src/tick/tick-resume.ts. The per-role cap is keyed by BASE role
(`baseRoleOf`) and sums the instance group's spend, matching the scheduler gate's
`roleCapVerdicts` (src/gates/role-cap-gates.ts) and the base-role keys config validation
enforces; the plan's `maxDailyCostUsdPerRole[role]` shorthand means that base-role key.

### Finish the stale code-path citation sweep, part 2a/5: `plans/portability.md`, part 5/7 (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 2/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/portability.md`'s "5/7 — Make the
agent binary configurable" section.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to this section. Its prose is a dense source of line pins past a file's end.

**Files touched.** `plans/portability.md` (only the named section). No source or test change.

**Acceptance criteria.**
- The inventory over the named section reports no cited path absent from the tree.
- No `<path>:<line>` in the named section names a line past that file's end.
- For each split module cited in the named section, the module named beside a symbol exports it
  (checked against the module's export list).
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 1c/5: `plans/portability.md`, parts 4a/7–4c/7 (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 1/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/portability.md`'s "4a/7 — Seed an
untracked config from a tracked template", "4b/7 — Untrack this repo's own config without
deleting it", and "4c/7 — Move README's rig notes into docs/backends.md" sections.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to these sections.

**Files touched.** `plans/portability.md` (only the named sections). No source or test change.

**Acceptance criteria.**
- The inventory over the named sections reports no cited path absent from the tree.
- No `<path>:<line>` in the named sections names a line past that file's end.
- For each split module cited in the named sections, the module named beside a symbol exports it
  (checked against the module's export list).
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 1a/5: `plans/portability.md`, parts 1/7–2/7 (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 1/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** Every path-shaped token in this part's plan-document sections names a path that exists
in the tree, every `<path>:<line>` names a line the file actually has, and a module that has
since split names the module that owns the symbol beside the citation. A reader who follows the
citation reaches the code it describes. The plans were audited before the landing, pi-facade,
config, loop, and events splits, so today a citation names a module that no longer exists or a
line past the file's end; the 2026-10-10 review of `plans/portability.md` named three remaining
classes — a helper pinned to the wrong landing module, a build-scope call pinned to a stale
module, and line pins past the file's end.

**Scope.** `plans/portability.md` sections "1/7 — GitHub Actions CI and a publishable npm
package" and "2/7 — Resolve the repo root, and target any branch". Disjoint from the other
citation-sweep parts, so the parts land cleanly in any order.

**Method (the other citation-sweep parts apply this same four-step method to their own scope).**
1. Inventory: scan the scope for path-shaped tokens and keep the ones whose path is absent from
   the tree; separately list every `<path>:<line>` whose line is past the file's end. A clean
   inventory over the scope is the acceptance check.
2. Split-aware map: for each moved module, name the one current module that owns the cited
   symbol — the root modules that moved into their own directory keep their file name, so
   `src/config/config.ts`, `src/loop/loop.ts`, `src/pi/pi.ts`, `src/git/git.ts`,
   `src/orchestrator/orchestrator.ts`, and `src/config/config-validation.ts` are the owners,
   while the `types`, `state`, and `merge` modules split into per-topic files — but a module
   that split into a facade plus
   implementations needs a per-citation symbol check, never a blanket rename. `git log
   --diff-filter=R --name-status` and `grep -rn <symbol> src` locate the owner.
3. Rewrite rule: replace the path with its current module and drop the old `:line` pin, keeping
   the symbol name in the surrounding prose. A path alone is honest; a stale number is not.
4. Historical audits: a dated "Verified as written" paragraph is a snapshot at the commit its
   heading names. Keep that commit reference; reword its line pins to symbol names rather than
   asserting a current line.

**Files touched.** `plans/portability.md` (only the named sections). No source or test change.

**Acceptance criteria.**
- The inventory over the named sections reports no cited path absent from the tree.
- No `<path>:<line>` in the named sections names a line past that file's end.
- For each split module cited in the named sections, the module named beside a symbol exports it
  (checked against the module's export list).
- `npm run test` is green.

### Finish the stale code-path citation sweep, part 1b/5: `plans/portability.md`, part 3/7 (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 1/5, which feature judged too large for one run; independent of the Agent backends series; siblings are the other citation-sweep parts; done 2026-10-10 by feature)

**Goal.** The same citation invariant as part 1a/5, for `plans/portability.md`'s "3/7 —
Harness-mediated config writes: take custom loops off the commit path" section.

**Method.** The four-step inventory, split-aware map, rewrite rule, and historical-audit rule of
part 1a/5, applied to this section.

**Files touched.** `plans/portability.md` (only the named section). No source or test change.

**Acceptance criteria.**
- The inventory over the named section reports no cited path absent from the tree.
- No `<path>:<line>` in the named section names a line past that file's end.
- For each split module cited in the named section, the module named beside a symbol exports it
  (checked against the module's export list).
- `npm run test` is green.

### Agent backends, part 6e/7: resume across a usage-window hold (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 6/7; requires part 6c/7 landed; done 2026-10-10 by feature)

Design: plans/agent-backends.md ("The subscription usage window", "Sessions"). The entry's
"Interactions (resume across a usage-window hold)" heading does not exist in the document; the
behavior is stated in §8 and §4.

Goal: a subscription claude run cut off by a rejected window keeps its worktree and resumes with
the same session id after `resetsAt`, instead of a fresh tick resetting the worktree and losing
its edits. Depends on 6c's hold.

**Approach.**
1. **Resume state.** The rate-limit end's outcome sets `state.resumePending` (src/tick/
   tick-verdict.ts sets it inline in the `error` arm, before `applyTickOutcome`; src/tick/
   tick-apply.ts's `applyTickOutcome` sets it too), so src/tick/tick-resume.ts's
   `planTickStart` treats the next run as a resume rather than a fresh tick. Because
   src/loop/loop-tick.ts's `runTickInLeasePhase` reads `resumePending` in its `finally`,
   before `applyTickOutcome` runs, the inline arming is what keeps the leased slot pinned
   and the worktree edits intact. `resolveTickVerdict` detects the rejected window through
   the shared `subscriptionWindowRejected` predicate (src/agent/claude/claude-account.ts) and
   returns an `error` outcome carrying `resumeCause: "rate-limit"`. The check sits before
   staging, so a dirty, content-bearing run no longer commits its half-done edits.
2. **Resume, not handoff.** After `resetsAt`, the run resumes with `--resume <same id>` through
   src/loop/loop-tick.ts; it is not a handoff, because the agent did not change and 6b never
   moves subscription seams to the fallback. The named `rate-limit` cause gives the resume bridge
   its own wording (src/prompt/prompt-followup.ts); nothing re-applies a note.
3. **No wasted within-run retry.** src/loop/loop-pi.ts's transient retry skips a subscription
   window rejection: the retry's bounded wait cannot outlast the window, and the fleet hold
   already defers the tick.
4. **Overage and API billing.** When overage or API billing does move a seam to its fallback,
   the 4/7 handoff rules apply unchanged; `subscriptionWindowRejected` reads false for an
   API-billed or overage run, so those keep the existing paths.

**Files touched.** src/agent/claude/claude-account.ts, src/tick/tick-verdict.ts,
src/tick/tick-apply.ts, src/tick/tick-outcome.ts, src/loop/loop-state.ts,
src/loop/loop-tick.ts, src/prompt/prompt-followup.ts, src/loop/loop-pi.ts.

**Tests.** Cases in test/tick-resume.test.ts (the rejected-window verdict, the lease pin
condition `slotPinnedForResume` evaluated on the post-verdict state, and the next tick's
resume) and test/loop-pi.test.ts (no within-run retry), both using fake-claude.

**Acceptance criteria.**
- An interrupted fake-claude author tick, a hold, then a reset produces one resume with the same
  session id, with the worktree edits intact.
- The resume's cause is named (not a plain fresh tick).
- `npm run test` green.

### Agent backends, part 6d/7: the usage-window display (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 6/7; requires parts 6a/7 and 6c/7 landed; done 2026-10-10 by feature)

Design: plans/agent-backends.md ("Display, in place of the daily spend").

Goal: the TUI, GUI, `tumwater status` and `tumwater role <id>` show the subscription window in
place of (or alongside) the daily spend. The "held until" wording is derived from the account's
rejected window (the same predicate fleet-hold.ts uses), so no separate held-state read is
needed.

**Approach.**
1. **Status payload.** src/status/status-data.ts gains a `claudeWindow` block (the most
   constrained window plus the full list, `only` classifying a subscription-only fleet and
   `heldUntil` the rejected window's deadline), carried through src/ui/status-payload.ts.
2. **Rendering, following the design table.**
   - **subscription only:** the window replaces the daily spend, e.g.
     "Claude 5h · 64% · resets 14:30" (the status word when no `utilization`), amber at
     `allowed_warning`, red with "claude seams held until 14:30" at `rejected`, and an "overage"
     marker while `isUsingOverage`.
   - **mixed:** both, the daily-spend badge with the window appended; the daily spend already
     covers priced seams only (6a folds subscription cost into notional spend).
   - **none:** unchanged.
   The single preformatted budget fragment is src/ui/badges.ts's `budgetBadge`, rendered by the
   TUI header (src/ui/status-render.ts) and carried preformatted in the payload; the GUI
   sidebar's spend card (src/ui/gui/gui-client-operator.ts, reached from gui-client-fleet.ts's
   renderSidebar) lists every window.
3. **Role view.** src/roles/role-view.ts collects the billing and its primary window;
   src/roles/role-render.ts shows "- Billing: subscription (5h window)" or "- Billing: API" for
   a claude seam.
4. **Docs.** README: the window display.

**Files touched.** src/status/status-data.ts, src/ui/status-payload.ts, src/ui/badges.ts,
src/ui/status-render.ts, src/ui/gui/gui-client-operator.ts, src/roles/role-view.ts,
src/roles/role-render.ts, src/agent/claude/claude-account.ts, README.md.

**Tests.** Cases in test/badges.test.ts, test/gui-client.test.ts, test/status-data.test.ts,
and test/role-view.test.ts.

**Acceptance criteria.**
- An all-subscription fleet's TUI and GUI show the window line and no daily-spend line.
- A mixed fleet shows both lines, the daily spend covering priced seams only.
- A pi-only fleet's rendering is byte-identical to before.
- `tumwater role <id>` names the billing for a claude seam.
- `npm run test` green.

### Agent backends, part 6b/7: subscription free-ness and the cap exemption (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 6/7; requires part 6a/7 landed; done 2026-10-10 by feature)

Design: plans/agent-backends.md ("Free-ness", "Every seam, checked").

Goal: a subscription claude seam is free money, so the daily cap never moves it to a fallback
and an all-subscription fleet resolves as free. Depends on 6a's account state.

**Approach.**
1. **Free predicate.** src/pi/pi-models.ts gained `seamFree(providers, seam, account)`, the one
   agent-aware rule: a claude seam is free while the account billing is `subscription` and no
   window is using overage, a pi seam is free when models.json prices it at zero, and everything
   else is not free. Overage is real money (plans/agent-backends.md §7), so `accountUsesOverage`
   mirrors the per-run `runCostIsReal` split: an overage subscription claude seam is priced like
   API spend. `piPairFree` (the `provider/model` form), `fallbackModelPair`, `fallbackModelFree`,
   and `fleetModelsFree` all take an optional `ClaudeAccount | null` and judge through it; an
   absent account file or API billing keeps today's refusal.
2. **Callers follow.** src/gates/budget-gates.ts reads the account once per poll and passes it to
   `pairFreeAt` and to `applyFallbackModel`; src/status/status-data.ts passes it to the
   `fleetModelsFree` / `fallbackModelFree` / seam-free reads; src/roles/role-view.ts and
   src/doctor/doctor-model-checks.ts read it for their `fallbackModelPair` verdict. `applyFallbackModel`
   (src/config/config-views.ts) gained an optional free predicate: a free tier keeps its own
   primary in the model map, a free role keeps its own override, and a free reviewer keeps its
   own model, while every priced seam still lands on its tier's fallback pair. So the gate leaves
   a subscription seam put at the cap, accepts a subscription claude pair as a budget `fallback`
   for a priced pi primary, and `fleetModelsFree` turns true for an all-subscription fleet (which
   6d renders as the window badge).
3. **Docs.** README states a subscription claude model with no overage is free and so is never
   moved to a budget fallback.

**Files touched.** src/pi/pi-models.ts, src/gates/budget-gates.ts, src/config/config-views.ts,
src/status/status-data.ts, src/roles/role-view.ts, src/doctor/doctor-model-checks.ts, README.md.

**Tests.** test/pi-models.test.ts (subscription free; API, overage, and absent refused),
test/budget-gates.test.ts (subscription fallback engages; a subscription seam stays put while a
priced pi seam moves; an overage subscription seam moves), test/config-views.test.ts
(applyFallbackModel's free predicate), test/role-view.test.ts and
test/doctor-model-checks.test.ts (a subscription claude fallback reads free).

**Acceptance criteria.**
- With the cap reached and account billing `subscription`, a subscription claude seam stays
  put while a priced pi seam moves to its fallback.
- A subscription claude pair is accepted as a budget `fallback` for a priced pi primary.
- `fleetModelsFree` is true when every seam is subscription claude and false when one seam is
  API-billed claude or the account is using overage.
- The role view and doctor judge a subscription claude fallback free, like the budget gate.
- With no account file or API billing, free-ness is exactly today's behavior.
- `npm run test` green.

### Agent backends, part 6c/7: the usage-window hold and its events (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 6/7; requires part 6a/7 landed; done 2026-10-10 by feature)

Design: plans/agent-backends.md ("Throttle", "Watchdogs and progress").

Goal: a rejected subscription window holds claude seams until it resets, so the fleet does not
burn a failed run per loop per poll. Depends on 6a's account state.

**Approach.**
1. **The hold.** A window reading with `status: "rejected"` and no overage places a
   provider-`claude` fleet hold until `resetsAt` (src/fleet/fleet-hold.ts and
   src/fleet/fleet-polls.ts). It joins the existing per-provider holds map, so
   `heldProviders()` gates scheduling exactly as a failure storm does. It covers subscription
   claude seams only: pi seams, and API-key claude seams, keep ticking. A rejected run is a
   transient — nothing is reset.
2. **Integration.** fleet-polls derives the window observation from the account state (via 6a's
   reader) alongside the runner failure observations, with the same self-lifting guarantee
   (a held fleet re-opens when `resetsAt` passes).
3. **Events (once per window, not per run).** `claude_window_warning` on the first
   `allowed_warning`, `claude_window_limited` `{windowType, resetsAt}` when the hold is placed,
   and `claude_window_reset` when it lifts (src/events/events.ts, src/events/event-format.ts).
   The field is `windowType` because the event's own `type` names the event.

**Files touched.** src/fleet/fleet-hold.ts, src/fleet/fleet-polls.ts,
src/agent/claude/claude-account.ts (reader use), src/config/config-views.ts,
src/loop/loop.ts, src/orchestrator/orchestrator.ts, src/gates/gate-polls.ts,
src/events/events.ts, src/events/event-format.ts, README.md.

**Landed note.** The hold is keyed by the seam hold key (config-views.ts seamHoldKey): a non-pi
backend keys by its agent id (configForRole clears a claude seam's pi provider), so claude seams
share the `claude` hold and pi's default seams (undefined) stay clear. LoopRunner.runProvider and
the reviewer's held-provider reads now use it, so claude failure storms also key `claude`
rather than undefined. The once-per-window warning memory lives in FleetGateStates beside the
holds map.

**Tests.** Cases in test/fleet-hold.test.ts, test/fleet-polls.test.ts, test/event-format-fleet.test.ts,
test/config-views.test.ts.

**Acceptance criteria.**
- A `rejected` five-hour reading holds subscription claude seams until `resetsAt` while pi seams
  and API claude seams tick.
- Many polls across one rejected window log `claude_window_limited` once and
  `claude_window_reset` once.
- A first `allowed_warning` logs `claude_window_warning` once.
- A window with overage, or after `resetsAt`, places no hold.
- `npm run test` green.

### Agent backends, part 6a/7: the claude account state and notional spend (planned 2026-10-10 by plan; split 2026-10-10 by plan from part 6/7; requires parts 4a/7, 4b/7 and 4e/7 landed; done 2026-10-10 by feature)

Design: plans/agent-backends.md ("Billing: subscription or API", "The subscription usage
window", "Testing").

Goal: detect whether a claude run is paid by a claude.ai subscription or an API key, persist
that answer, and keep subscription cost out of the daily dollar budget. This is the foundation
the sibling 6b/7–6e/7 parts read; it changes no scheduling, badge, or display behavior on its own.

**Approach.**
1. **Account state.** src/agent/claude/claude-account.ts reads and writes
   `.tumwater/state/claude-account.json`:
   `{billing, subscriptionType, observedAt, windows: {<rateLimitType>: {status, resetsAt,
   utilization?, overageStatus, isUsingOverage, observedAt}}}`. Exports the `ClaudeAccount`,
   `ClaudeBilling` types plus an internal `ClaudeWindow` shape and a reader that treats a
   window past its `resetsAt` as reset (and an `observedAt`-less file as absent). Only the
   orchestrator process writes it; the path lives in src/paths.ts.
2. **Seeding.** seedClaudeAccount (claude-account.ts) seeds before the first run from the
   presence of `ANTHROPIC_API_KEY`/a third-party provider env and, otherwise, `claude auth
   status` (`authMethod: "claude.ai"`, `subscriptionType`); src/gates/startup-gate.ts calls it
   when a seam routes to claude and an account file is absent. Doctor's existing `claude auth
   status` check already surfaces the same billing.
3. **Per-run observation.** src/tick/tick-finalize.ts (which has the repo root; run-agent.ts does
   not) folds each tick's `billing` and newest `rateWindows` — carried on `PiRunResult` in
   src/pi/pi-run-result.ts and collected by src/tick/tick-usage.ts — into the account file,
   stamping `observedAt`.
4. **Spend.** src/tick/tick-usage.ts folds a subscription run's `costUsd` into a new
   `notionalCostUsd` and never calls `recordDailyCost`; an API run, or a run that saw
   `isUsingOverage` at any point, folds its cost into `costUsd` as today (its cost is real
   money). src/pi/pi-run-result.ts's `runCostIsReal` is the one predicate both the tick fold
   and the landing accumulator split on. A landing/review run (reviewer + conflict resolution)
   is split the same way in src/landing/landing-slot.ts: real cost rides the landed event's
   `costUsd`, notional rides a new `notionalCostUsd` field. `tick_end` gains `notionalCostUsd`
   and `billing` (src/events/events.ts's usageFragment and src/events/event-read.ts's
   eventUsage, following the omit-when-zero convention the other usage fields use).
5. **Report.** src/report/report-data.ts sums notional spend apart from the totals — fleet-wide
   and, for a `--role` scope, the role's own tick notional (its landing slot's is fleet-wide
   like its cost) — and src/report/report-render.ts prints it on its own line ("claude
   subscription, API-equivalent: $X notional"), never in the total.
6. **Docs.** README: billing detection and overage counting as real spend.

**Files touched.** src/agent/claude/claude-account.ts (new), src/paths.ts,
src/tick/tick-finalize.ts, src/gates/startup-gate.ts, src/tick/tick-usage.ts,
src/pi/pi-run-result.ts, src/landing/landing-slot.ts, src/events/events.ts,
src/events/event-read.ts, src/report/report-data.ts, src/report/report-render.ts, README.md.

**Tests.** test/claude-account.test.ts (new); cases in test/tick-usage.test.ts,
test/landing-slot.test.ts, test/report-data.test.ts.

**Acceptance criteria.**
- With `maxDailyCostUsd: 15` and subscription billing, ten fake-claude ticks costing $3 each
  leave the daily spend at $0, and `tumwater report` shows "$30.00 notional".
- The same ticks with `isUsingOverage: true` count $30 against the cap.
- With `apiKeySource: "ANTHROPIC_API_KEY"`, costs count against the cap exactly as a priced pi
  model's do, and the report's notional line stays at $0.
- A window whose `resetsAt` has passed reads as reset; an absent account file reads as no
  subscription.
- `npm run test` green.

### A numbered read half for `tumwater plan`/`bug`: `--list` (planned 2026-10-10 by plan; independent of the Agent backends series; sibling of the landed `tumwater plan --edit/--cancel` and `tumwater bug --edit/--cancel`; done 2026-10-10 by feature)

**Goal.** `tumwater plan --list [--json]` and `tumwater bug --list [--json]` list the entries their
`--edit <n>` / `--cancel <n>` flags address, each numbered 1..N with its eligibility hold mark, so
an operator can see the position a command takes instead of counting `### ` headings by eye. Today
the help says `--cancel <n>` / `--edit <n>` target "the Nth entry … as `tumwater backlog` lists
it", but `tumwater backlog` prints no numbers (src/backlog/backlog-render.ts); `tumwater prompt
--list` and `tumwater questions` are already numbered, so plan/bug are the one operator queue
whose read half hides its positions. Additive only: `tumwater backlog` and its renderer stay
unchanged.

**Approach.**
1. **Shared lister.** In src/backlog/backlog-write.ts add `listAndAnnounce(root, args, command,
   fileName, sectionTitle)`, modeled on `cancelAndAnnounce`: consume one boolean `--list` (repeats
   refused with `rejectRepeatFlag`), one `--json`, tolerate `--help`/`-h`, and refuse every other
   token (positional or flag) through `rejectUnknownArgs`. No wake and no `requireReadyRepo` gate,
   matching the read-only `tumwater backlog` / `tumwater questions` precedent.
2. **Numbered view.** For plans read `plannedPlanEntries(root)`, for bugs `openBugEntries(root)`
   (backlog.ts), pair them with `backlogHolds(root).plans` / `.bugs` (backlog-eligibility.ts,
   already the parallel verdict array `tumwater backlog` renders), and build
   `{ position: i + 1, title, body, hold }`. These are the same entries, in the same order,
   that `locateEntry`/`actionableEntryRanges` number for `--edit`/`--cancel`, so one fixture can
   pin that a `--list` position and a `--cancel` position name the same entry. Prose prints a
   header line `planned features in PLANS.md:` (or `open bugs in BUGS.md:`) then
   `${n}. ${title}${holdMark(hold)}` per entry — `holdMark` (already imported by the renderer)
   keeps the marks byte-identical to `tumwater backlog` — and `no planned features` / `no open
   bugs` on an empty or missing file, exit 0, like `openQuestionList`'s `no open questions`.
   `--json` prints `{ entries: [{ position, title, body, hold }] }`, the questions --json shape
   (src/cli/question-commands.ts) with `hold` the serialized `EntryHold` (null when eligible).
3. **Dispatch.** In src/cli.ts, in `case "bug"` and `case "plan"`, intercept
   `args.includes("--list")` before the `--edit`/`--cancel`/file branches and call the shared
   lister with the section (`Open`/`BUGS.md`, `Planned`/`PLANS.md`). `--list` is flag-shaped and
   today merely rejected, so the addition takes no existing invocation.
4. **Docs.** src/cli/help.ts gains a `tumwater plan --list [--json]` stanza and a `tumwater bug
   --list [--json]` stanza, each naming the file/section and pointing at `--edit`/`--cancel`;
   README.md's prompt-table row mentions the numbered read half beside `--cancel`/`--edit`,
   mirroring how it describes `tumwater prompt --list` and `tumwater questions`.

**Files touched.**
- src/backlog/backlog-write.ts (`listAndAnnounce`; imports `plannedPlanEntries`, `openBugEntries`,
  `backlogHolds`, `holdMark`)
- src/cli.ts (the two `--list` interceptions)
- src/cli/help.ts (two stanzas)
- README.md (prompt-table wording)

Tests: test/backlog-write.test.ts — a fixture with two planned entries (one eligible, one
`requires X` blocked) and two open bugs (one refused): `plan --list` prints `1. …` / `2. … [blocked:
requires X]`, `bug --list` prints the refused bug's `[refused]`; `--json` carries positions
`[1,2]`, verbatim bodies, and the same `hold` values; `plan --cancel 2` removes exactly the
entry `plan --list` numbered 2, and `plan --edit 1` rewrites the one numbered 1; an empty section
prints the "no …" line and exits 0; a missing file too; `plan --list extra` and `plan --list
--bogus` fail naming the argument, and repeated `--list`/`--json` fail; `tumwater help plan` and
`help bug` name `--list`.

**Acceptance criteria.**
- `tumwater plan --list` prints PLANS.md `## Planned` entries numbered 1..N in file order, each
  title verbatim plus its `[refused]`/`[needs review]`/`[needs replan]`/`[blocked: requires …]`
  mark exactly as `tumwater backlog` renders it; eligible entries carry no mark.
- `tumwater bug --list` does the same for BUGS.md `## Open`; both `--json` forms print
  `{ entries: [{ position, title, body, hold }] }` with bodies verbatim.
- A position printed by `--list` is the same entry `--cancel <n>` removes and `--edit <n>`
  rewrites (pinned by one fixture), for both plan and bug.
- An empty or missing section prints the command's `no …` line and exits 0; a positional or
  unknown flag beside `--list`, or a repeated `--list`/`--json`, fails naming the argument.
- `tumwater backlog`, its Markdown render, and its `--json` payload are unchanged — the existing
  backlog-render tests pass without edits.
- `npm run test` green.

### Agent backends, part 5/7: `role_notes` over MCP and the prompt dialect (planned 2026-10-09 by operator; requires parts 4a/7 and 4b/7 landed; done 2026-10-10 by feature)

Design: plans/agent-backends.md ("What the pi extensions did, per backend").

**Approach.**
1. **MCP server.** src/agent/mcp/role-notes-server.ts is a dependency-free stdio MCP server
   (JSON-RPC `initialize`, `tools/list`, `tools/call`) exposing `role_notes {text}`.
   - It writes through the same atomic, 4 KB-capped function as src/pi-extension/role-notes.ts
     (extract it to src/agent/role-notes-write.ts).
   - The claude adapter passes it with
     `--mcp-config '{"mcpServers":{"tumwater":{"command":"node","args":[<dist path>]}}}'` only
     when the run has a `notesPath`.
2. **Dialect.** `PromptDialect` on each backend supplies:
   - the notes tool name (`role_notes` / `mcp__tumwater__role_notes`);
   - the read-range phrase;
   - the oversized-output bullet: pi's head+tail marker vs claude's "large output is saved to a
     file it names — read that file in ranges".

   `ROLE_NOTES_INSTRUCTION` and `CONTEXT_BUDGET_RULE` (src/prompt/prompt.ts) and
   prompt-followup.ts become functions of the dialect. pi's text stays byte-identical.
3. **AGENTS.md.** When the worktree has `AGENTS.md` and no `CLAUDE.md`, claude runs get
   `--append-system-prompt-file AGENTS.md`.

**Interactions (resume and handoff prompts).** Added 2026-10-09 by operator.
- **Prompt texts.** The resume and handoff texts become dialect functions alongside
  `ROLE_NOTES_INSTRUCTION`, wherever they name a tool or the notes file:
  - `buildResumePrompt` and `buildHandoffPrompt` (src/tick/tick-resume.ts);
  - `buildRevisionNote` and `buildConflictHandbackNote`.
  A pi→claude handoff renders in claude's dialect, and a claude→pi handoff in pi's.
- **Per-run flags.** claude does not keep flags across `--resume`, so every claude invocation
  that writes notes must pass `--mcp-config` again, including resumes, transient retries and
  SUMMARY follow-ups. Test it with a resumed claude tick on fake-claude.

**Files touched.**
- src/agent/mcp/role-notes-server.ts, src/agent/role-notes-write.ts (new)
- src/pi-extension/role-notes.ts
- src/agent/claude/claude-args.ts, src/agent/claude/claude-backend.ts
- src/prompt/prompt.ts, src/prompt/prompt-followup.ts, src/prompt/dialect.ts (new)
- src/tick/tick-prompt.ts, src/tick/tick-resume.ts

Tests: test/role-notes-mcp.test.ts (spawn the server, call the tool, check the file and the
cap), test/prompt-dialect.test.ts (pi byte-identity and the claude wording), and claude-run
cases for the MCP config on fresh and resumed runs.

**Acceptance criteria.**
- **Unchanged pi.** pi tick prompts are byte-identical to before.
- **claude prompts.** A claude tick prompt names `mcp__tumwater__role_notes`. A claude authoring
  run on fake-claude receives `--mcp-config` naming the server. Director, review and landing runs
  do not.
- **Server.** The server rejects a note over 4 KB with a tool error, and leaves the old note
  intact.
- `npm run test` green.

**Landed.** src/agent/role-notes-write.ts holds the shared 4 KB cap, schema, validation, and
atomic write; the pi extension and src/agent/mcp/role-notes-server.ts (a dependency-free stdio
MCP server) both call it, and the claude adapter passes that server as inline `--mcp-config`
plus TUMWATER_NOTES_PATH whenever the run carries a notebook — on resumes too, since claude keeps
no flags across `--resume`. src/prompt/dialect.ts holds pi's and claude's only backend-specific
prompt text; `contextBudgetRule`/`roleNotesInstruction` and `buildResumePrompt` take a dialect,
and pi's text is byte-identical (test/prompt-dialect.test.ts). `buildHandoffPrompt`,
`buildRevisionNote`, and `buildConflictHandbackNote` name no tool or notes file, so they needed no
dialect argument; a handoff's assembled tick prompt already carries the right dialect. The
AGENTS.md append was already in the part 3b/7 invocation builder, so this part changed no code
for it.

### Agent backends, part 4c/7: per-agent binary resolution, passthrough args and the startup gate (planned 2026-10-09 by plan; split 2026-10-09 by plan from part 4/7; requires parts 4a/7 and 4b/7 landed; done 2026-10-10 by feature)

Design: plans/agent-backends.md ("Config" back-compat; "Every seam, checked" — startup row).

**Approach.**
1. `resolveAgentBin` in src/pi/pi-bin.ts becomes `resolveAgentBin(config, agent)`:
   `TUMWATER_<ID>_BIN` env → `config.agents?.[agent]?.bin` (with `agentBin` still read for
   `pi`) → the backend's `defaultBin`. `AgentBackend.resolveBin` (src/agent/agent-backend.ts)
   resolves through it.
2. src/pi/pi-backend.ts and src/agent/claude/claude-backend.ts resolve their own entries, so
   `agents.pi.bin`/`agents.claude.bin` take effect while `TUMWATER_PI_BIN`/`TUMWATER_CLAUDE_BIN`
   keep working.
3. **Passthrough args.** `claudeBackend.invocation` passes `config.agents?.claude?.args` as
   `claudeArgs`' `args` (the builder already rejects reserved flags); pi keeps reading the
   resolved `agents.pi.args` as `piArgs`.
4. **Startup gate.** src/gates/startup-gate.ts checks the binary of every agent that `agent`
   plus any per-role or `review` selector makes an enabled seam resolve to, through the same
   `findAgentBinary`.

**Files touched.** src/pi/pi-bin.ts, src/pi/pi-backend.ts, src/agent/agent-backend.ts,
src/agent/claude/claude-backend.ts, src/agent/run-agent.ts, src/gates/startup-gate.ts,
src/config/config-views.ts.

**Acceptance criteria.**
- `agents.claude.bin` and `TUMWATER_CLAUDE_BIN` each change the binary a claude run spawns;
  `agents.pi.bin` and legacy `agentBin` resolve the pi binary.
- `agents.claude.args: ["--debug"]` reaches fake-claude's recorded argv after the harness
  flags; a reserved flag (e.g. `--verbose`, itself harness-managed) in that array fails
  validation, not the run.
- The startup gate refuses to boot when an enabled seam's agent binary is missing, and names
  that agent's binary rather than pi's.
- `npm run test` green.

**Landed.** `resolveAgentBin` takes an optional per-agent `{binEnv, defaultBin}`: the backends
pass their own fields, while the startup gate derives the reserved agents' conventional
`TUMWATER_<ID>_BIN`/default-binary values. `resolveBinFrom` is now module-private (`resolveAgentBin`
is its one caller), `resolvedAgentConfig` treats `piArgs` as optional so a bare `{}` type-checks,
and the acceptance example moved off `--verbose` to the non-reserved `--debug`. The spawn-error
path (`spawnErrorMessage` in src/agent/run-agent.ts) takes the backend so a claude config-sourced
spawn failure names `agents.claude.bin`; `agentBinConfigKey` centralizes that key for the
missing-binary and spawn-error wording. Doctor's `checkAgentBinary` still checks only pi's binary
(its agent-aware checks are part 4e/7), so the shared comments name that scope rather than claiming
the gate and doctor can never disagree.

### Agent backends, part 4f/7: agent labels and docs (planned 2026-10-09 by plan; split 2026-10-09 by plan from part 4/7; requires part 4b/7 landed; done 2026-10-10 by feature)

Design: plans/agent-backends.md ("Every seam, checked" — status/TUI/GUI/events rows).

**Approach.**
1. **Labels.** "pi default" becomes "`<agent>` default" in src/roles/role-render.ts and
   src/ui/badges.ts; the agent-qualified selector (`claude/claude-sonnet-5-5`) is written at
   the shared `modelSelectorField` seam (src/config/config-views.ts), so `tick_start`/
   `review_start` events, `model_changed`, and the status rows all carry the agent with no
   change in src/events/event-format.ts. RoleViewPayload gains `agent`
   (src/roles/role-view.ts) and the status snapshot's budget gains the fleet `agent`
   (src/status/status-data.ts) for the badge's and role view's default labels.
2. **Docs.** README "Backends": `agent`, routing, and the expected-spend note;
   docs/backends.md gains a Claude Code section and links plans/agent-backends.md. The
   "Built on pi" tagline lives inside README's protected initial-prompt block, so it is left
   unchanged.

**Files touched.** src/config/config-views.ts, src/roles/role-view.ts,
src/roles/role-render.ts, src/ui/badges.ts, src/status/status-data.ts; README.md,
docs/backends.md; test/config-views.test.ts, test/role-view.test.ts, test/badges.test.ts,
test/status-data.test.ts, test/gui-operator.test.ts.

**Acceptance criteria.**
- With `agent: "claude"` and no `model`, role-render, badges and a `tick_start` event all name
  `claude default`/`claude/claude-sonnet-5-5`; with `agent: "pi"` the strings stay
  byte-identical to before.
- README and docs/backends.md describe `agent`/`agents`, routing, and the spend expectation;
  docs/backends.md links plans/agent-backends.md.
- `npm run test` green.

### Agent backends, part 4d/7: resume and handoff under routing (planned 2026-10-09 by plan; split 2026-10-09 by plan from part 4/7; requires part 4b/7 landed; done 2026-10-10 by feature)

Design: plans/agent-backends.md ("Sessions"); the original part 4/7 "Interactions" section.

Routing lets a seam's agent change between an interrupted tick and the next one, through a
config edit or the fallback moving a claude seam to a pi fallback or back.

**Approach.**
1. `planTickStart` (src/tick/tick-resume.ts), which loop-tick.ts already calls with
   `agent: cfg.agent ?? DEFAULT_AGENT`, compares the newest session-ledger author line's `agent`
   with the tick's `agent`; a mismatch plans a `handoff` (fresh session, worktree left as is,
   `buildHandoffPrompt` from src/prompt/prompt-followup.ts) instead of a resume.
2. It reads `cfg.agent` from the same resolved view the spawn uses (`configForRole` plus the
   fallback view), not a separate resolution.

**Files touched.** src/tick/tick-resume.ts, src/loop/loop-tick.ts.

**Acceptance criteria (on fake-pi and fake-claude).**
- **Fallback flip.** An interrupted claude author tick, with the fallback active on the next
  tick, runs a fresh pi session in the unreset worktree; its prompt carries the handoff bridge,
  the revision note when a revision was in flight, and the hand-back note when one was applied.
- **Config flip mid-revision.** Changing `agent` from pi to claude while a revision is
  interrupted does the same and does not re-cherry-pick the rejected diff.
- **Mixed seams.** A conflict resolver routed to a different agent than the author writes its
  ledger line in the author's session dir; the author's next resume is then a handoff even
  though its own agent did not change.
- **Selectors.** The resume check and the spawn read the same `cfg.agent`.
- `npm run test` green.

Note (2026-10-10 by feature): this behavior was already present on main when the plan was
picked up. The session-ledger `handoff` and the newest-author-line `agent` comparison landed in
part 2/7; the backend-aware resume guard in parts 3c/3d; and the `cfg.agent` routing in part
4b/7 (`loop-tick.ts` passes `cfg.agent ?? DEFAULT_AGENT`, the fallback view's agent while an
episode is active). This tick added tests for the mixed-seam gate and the fallback-view
selector (test/tick-resume.test.ts) and moved the entry to Done; no src change was needed.

### Agent backends, part 4e/7: doctor for claude (planned 2026-10-09 by plan; split 2026-10-09 by plan from part 4/7; requires part 4b/7 landed; done 2026-10-10 by feature)

Design: plans/agent-backends.md ("Sessions" retention; "Every seam, checked" doctor row).

**Approach.** Extend src/doctor/doctor-checks.ts and src/doctor/doctor-model-checks.ts:
- claude: `claude auth status` under the scrubbed claude env must report `loggedIn`, and doctor
  prints the billing it implies (subscription type, or API key);
- the installed `claude --version` must be at least a per-model `minVersion` in the claude
  adapter (a table added to src/agent/claude/claude-backend.ts; 2.1.280 for the three tier
  defaults), and doctor prints it;
- claude selectors skip the models.json lookup in the model sweep;
- a pi provider named `claude` in the fleet warns (agent ids are reserved);
- the `off`/`minimal` `--effort` clamp is noted;
- the total size of claude's transcript dirs is reported.

**Files touched.** src/agent/agent-backend.ts (the `minVersion` seam),
src/agent/claude/claude-backend.ts, src/doctor/doctor-checks.ts,
src/doctor/doctor-model-checks.ts, src/doctor/doctor.ts.

**Acceptance criteria.**
- Doctor fails "claude auth" when fake `claude auth status` reports `loggedIn: false`.
- It fails "claude version" when fake `claude --version` reports 2.1.216 with Opus configured.
- A claude-routed config produces no models.json resolution error; a pi provider named `claude`
  yields a warning.
- Doctor reports the transcript-dir total size.
- `npm run test` green.

### Scope the failure digest to one role: `tumwater report --failures --role <id>` (planned 2026-10-10 by plan; sibling of the landed "Scope the usage report to one role: `tumwater report --role <id>`"; independent of the Agent backends series; done 2026-10-10 by feature)

**Goal.** `tumwater report --failures --role <id> [--days N]` and `tumwater report --failures
--role <id> --since <duration>` (text and `--json`) show only that role group's failure evidence —
its outcome rows, current-vs-preceding deltas, time/spend and loss causes, error/warning/
rejection/review-failure clusters, landings, and state changes — so an operator can diagnose one
loop without reading the fleet's digest. Today the combination is rejected as rival shapes
(src/report/report.ts: `failRivalShapes("report --role", "--failures", ...)`), the deferred half
of the landed usage-report scoping plan. Out of scope: the GUI `/api/failures` view and the TUI
Failures pane, which stay fleet-wide.

**Approach.**
1. **Collector scope.** In src/failure/failure-data.ts give `collectFailureReport(root, days,
   role?)`, `collectFailureReportSince(root, sinceMs, role?)`, and the shared
   `assembleFailureReport` an optional `role`. One internal helper `scopeToRole(events, base)`
   keeps events whose `baseRoleOf(eventRole(ev)) === base` — and, for the role-scoped harness
   transitions that log loop `harness` and name the affected role in `role` (a role pause, its
   streak breaker, its cap), whose `baseRoleOf(ev.role) === base` — so instance ids (`feature-2`)
   fold into their group exactly as `report --role` and the per-role cap do, and a scoped digest
   keeps the transitions that explain why the loop stopped. Apply it to the `current` and `prior`
   partitions and to the `allEvents` array the loss-cause fold reads, so every section derived
   from them narrows. Keep the unfiltered read's first event for `oldestEventDate`/window
   completeness (passed alongside `window`) so a scoped `partial` line still names log retention,
   not the role's own first event.
2. **Data shape and cache.** Add `role?: string` to `FailureReportData`, set to the base role.
   The day collector's `failureDigestCache` key is `${root}\u0000${days}`; append the base role so a
   scoped and a fleet digest cannot collide (the `--since` collector is not memoized).
3. **CLI.** In src/report/report.ts read `--role` through the existing `parseRoleScope`,
   delete the `--failures` rival-shape guard, and pass the role to both collectors (day and
   `--since`, text and `--json`). src/cli.ts's `case "report"` already admits `ROLE_FLAG` and
   `--failures`, so no gate change is needed.
4. **Render.** In src/failure/failure-render.ts `renderFailureMarkdown`, print a `role: <base>`
   line under the window line when `data.role` is set (mirroring report-render.ts's role line);
   when scoped, retitle the `## Fleet state changes` section to `## State changes` so it does not
   claim fleet scope. Section titles otherwise stay fleet-neutral.
5. **Docs.** src/cli/help.ts adds `--role <id>` to the `--failures` stanzas for both `--days` and
   `--since`; README.md's report row drops the "not combinable with `--failures`" clause and
   states that `--role` scopes the failure digest too.

**Files touched.**
- src/failure/failure-data.ts (optional `role`; `scopeToRole`; cache key; `FailureReportData.role`)
- src/failure/failure-render.ts (`role` line; scoped state-changes heading)
- src/report/report.ts (`parseRoleScope`; remove `failRivalShapes`; pass role)
- src/cli/help.ts (usage)
- README.md (report row wording)

Tests: test/failure-render.test.ts — a two-role fixture (`feature` and `qa` tick_end, warnings, a
rejection, a landed merge, and a `role_streak_paused`/`role_cap_paused` pair on loop `harness`)
collected with `role: "qa"` prints only `qa`'s outcome, delta, time-spend, cluster, landing and
state-change lines and carries the `role: qa` header with the `## State changes` heading, while
the same fixture with no role still shows both roles and `## Fleet state changes`; an instance id
(`feature-2`) scopes with its base `feature`; a role with no events reports the empty window; a
scoped partial window names the whole log's oldest event, not the role's first. test/report.test.ts
— `runCli(root, "report", "--failures", "--role", "qa")` succeeds (no rival-shape error) and names
`qa`; the `--json` payload carries `"role": "qa"`; `--role bogus` still fails with the shared
unknown-role message; `report --help` names the combination.

**Acceptance criteria.**
- `tumwater report --failures --role qa` (text) prints `role: qa` under the window line and shows
  only `qa`'s rows in Outcome by role, Deltas, Time and spend, loss causes, error clusters, and
  landings; the state-changes section is titled `## State changes`.
- `tumwater report --failures --role qa --since 90m` does the same over the trailing window, and
  `--json` carries `"role": "qa"`.
- `tumwater report --failures` without `--role` is unchanged — the existing failure-render and
  failure-time-spend tests pass without edits — and the GUI/TUI failure surfaces are untouched.
- `--role bogus` fails with the shared unknown-role message; `report --role qa --failures` no
  longer fails as rival shapes; `tumwater help report` documents the combination; README no
  longer says it is rejected.
- `npm run test` green.

### Warn before a loop reaches its own daily cap: the `role_cap_warning` event (planned 2026-10-09 by plan; independent of the Agent backends series; done 2026-10-10 by feature)

**Goal.** A loop whose local-day spend crosses 80% of its own `maxDailyCostUsdPerRole` cap logs
one `role_cap_warning` event while it is still ticking, so the configured `notify` hook can page
the operator while there is still room to raise the cap. It is the per-role twin of the fleet's
`budget_warning` (src/gates/budget-gates.ts), which the per-role cap does not have today: the
first event a per-role cap emits is `role_cap_paused`, when the loop already stops. Scheduling
is untouched — the warning is observability only.

**Context.** src/gates/role-cap-gates.ts already holds the pure verdict and the edge-triggered
bookkeeping (`roleCapVerdicts`, `newRoleCapGateState`, `pollRoleCapGate`), so the warning is one
more band in the same state machine. `budgetWarning` (src/budget/budget.ts) is the fleet gate's
80% predicate (`spentUsd >= cap * BUDGET_WARNING_FRACTION`, false for absent/non-finite/≤0 caps),
and a per-role warning reuses it rather than minting a second threshold. The per-role figures are
the group's summed `verdict.spentUsd` against the base role's cap, exactly as `role_cap_paused`
reads them, so instances (`feature`, `feature-2`) warn as one group.

**Approach.**
1. src/gates/role-cap-gates.ts: `RoleCapGateState` gains `warned: Set<string>` (base roles already
   warned in the current band); `newRoleCapGateState` initializes it. In `pollRoleCapGate`'s
   per-base loop, after the `over`/resume branch, compute `const cap = caps?.[base]` and
   `const warn = !verdict.over && cap !== undefined && budgetWarning({ spentUsd: verdict.spentUsd,
   capUsd: cap })` (import `budgetWarning` beside `dailyCost`/`todayStamp`). On a
   `warn && !state.warned.has(base)` crossing, `logEventBestEffort(root, { loop: "harness", type:
   "role_cap_warning", role: base, spentUsd: verdict.spentUsd, capUsd: cap })` and add `base` to
   `warned`; when `!warn`, delete `base`. The delete re-arms the warning after spend falls back
   below (a raised cap or a new day), and skipping `over` polls matches the fleet gate's "warn
   only while open" rule: a poll that jumps straight to the cap logs only `role_cap_paused`.
2. src/events/events.ts: add `| "role_cap_warning"` to the `HarnessEvent` type union beside
   `role_cap_paused`, with the carries-`role`/`spentUsd`/`capUsd` comment.
3. src/events/event-format.ts: a `case "role_cap_warning":` beside the `budget_warning` and
   `role_cap_paused` cases — `role ${textOr(e.role)} at ${budgetPhrase(e.spentUsd, e.capUsd)} of its
   daily cap — it keeps ticking; raise or remove the cap in tumwater.json before it pauses`.
4. src/events/notify.ts: add `"role_cap_warning"` to `NOTIFY_EVENT_TYPES` with its comment, so a
   configured notify command pages on it like the fleet `budget_warning`.
5. src/ui/tone.ts: add `"role_cap_warning"` to `PROBLEM_EVENTS` beside `budget_warning`.
6. docs/how-it-works.md: the `maxDailyCostUsdPerRole` bullet in "Spend and pausing" gains the 80%
   warning sentence, mirroring the `maxDailyCostUsd` bullet's.

**Files touched.**
- src/gates/role-cap-gates.ts (`RoleCapGateState`, `newRoleCapGateState`, `pollRoleCapGate`)
- src/events/events.ts (type union)
- src/events/event-format.ts (`formatEvent` case)
- src/events/notify.ts (`NOTIFY_EVENT_TYPES`)
- src/ui/tone.ts (`PROBLEM_EVENTS`)
- docs/how-it-works.md

Tests: test/role-cap-gates.test.ts — an 80%-crossing poll over a two-step spend logs exactly one
`role_cap_warning` with `{role, spentUsd, capUsd}`, returns no paused id and logs no
`role_cap_paused`; a drop below 80% then a re-crossing logs a second warning; a single poll that
jumps from below 80% to at/over the cap logs only `role_cap_paused`; an absent/0 cap warns
nothing. test/event-format-fleet.test.ts — the rendered line names the role, the spend against
the cap, and that the loop keeps ticking. test/notify.test.ts — extend the pinned
`NOTIFY_EVENT_TYPES` allowlist assertion with `role_cap_warning`.

**Acceptance criteria.**
- A base role's summed local-day spend at or past 80% of a finite positive
  `maxDailyCostUsdPerRole` entry, while still below the cap, logs exactly one `role_cap_warning`
  carrying `role`, `spentUsd`, and `capUsd`; the returned paused set stays empty and no
  `role_cap_paused` is logged for that role.
- Spending the remaining band in one poll to reach or exceed the cap logs only `role_cap_paused`
  on that poll, and dropping below 80% before re-crossing logs the warning again.
- A cap of 0, undefined, or absent logs no warning, and the director stays exempt exactly as it is
  from `role_cap_paused`.
- `tumwater logs` renders the event naming the role, its spend against its cap, and that the loop
  keeps ticking; `NOTIFY_EVENT_TYPES` includes it; docs/how-it-works.md names the per-role warning.
- `npm run test` green.

### Pause and resume the whole fleet from `tumwater tui`: the `Ctrl+F` toggle (planned 2026-10-10 by plan; independent of the Agent backends series; done 2026-10-10 by feature)

**Goal.** `Ctrl+F` in `tumwater tui` toggles the fleet pause through the same
`pauseFleet`/`resumeFleet` marker writers `tumwater pause`/`resume` and the dashboard's
`/api/pause` call, so an operator watching the terminal can hold or release the whole fleet
without a second terminal. Today the TUI shows the fleet-pause alert (`fleetAlerts`' `paused`
entry, src/ui/fleet-alerts.ts) and offers the per-loop `Ctrl+P`, but no key writes the fleet
marker; the GUI already has a pause control and its alert carries a Resume action the TUI
cannot offer.

**Context.** src/ui/tui/tui-keys.ts's `createTuiKeys` already imports `pausedRoles`/`pauseRole`/
`resumeRole` from src/fleet/fleet-state.ts, where `pauseFleet`, `resumeFleet` and the reader
`isFleetPaused` live as the single marker writers shared by src/operator/operator-commands.ts's
`cmdPause`/`cmdResume` and src/gui/gui-endpoint-commands.ts's `/api/pause` — so the TUI cannot
drift on marker format or idempotence. Confirmation wording reuses the shared base lines
`fleetPausePhrase()`/`fleetResumePhrase()` (src/text/phrases.ts), which the event feed and the
failure digest already share. `Ctrl+F` is free: the handler's only ctrl keys are D, C, B, P, A,
W, R, N and T.

**Approach.**
1. src/ui/tui/tui-keys.ts: import `isFleetPaused`, `pauseFleet`, `resumeFleet` from
   src/fleet/fleet-state.ts and `fleetPausePhrase`, `fleetResumePhrase` from src/text/phrases.ts.
   Add a `Ctrl+F` branch after the `Ctrl+B` branch and before the per-loop-controls branch,
   guarded `!budgetMode && !rolePromptFor` so it never fires while an editor holds the prompt
   line (the same inertness the per-loop keys have): read `const paused = isFleetPaused(root)`;
   when paused call `resumeFleet(root)` and flash
   `changed ? fleetResumePhrase() : "fleet was not paused"`; otherwise call `pauseFleet(root)`
   and flash `changed ? fleetPausePhrase() : "fleet is already paused"`. Wrap it in the same
   `try`/`catch` → `flashError` other disk-writing branches use, then `deps.requestRender()` so
   the next frame's `fleetAlerts` shows or drops the pause alert.
2. src/ui/tui/tui-frame.ts: the Activity/default `hintLine` branch gains `["Ctrl+F", "pause fleet"]`
   after `["Ctrl+B", "daily cap"]`.
3. docs/how-it-works.md's Operator notes TUI bullet: name `Ctrl+F` as the fleet pause/resume
   toggle (in-flight ticks finish; the director keeps running), mirroring the pause alert's
   detail line.

**Files touched.**
- src/ui/tui/tui-keys.ts (`createTuiKeys`'s dispatch)
- src/ui/tui/tui-frame.ts (`hintLine`)
- test/tui-operator-keys.test.ts, test/tui-frame.test.ts
- docs/how-it-works.md

Tests: test/tui-operator-keys.test.ts (the operator-controls topic slice, which already imports
`pauseFleet`/`pausedRoles` and builds its fake TTY with `makeTuiRepo`/`withTui`) — `Ctrl+F` makes
`isFleetPaused(repo)` true and flashes `fleet paused — role loops stop starting new ticks`, the
frame then matches `/The fleet is paused/`; a second `Ctrl+F` clears it (`isFleetPaused` false)
and flashes `fleet resumed — role loops tick again`; while budget-edit mode or role-prompt mode
holds the line, `Ctrl+F` writes no marker. test/tui-frame.test.ts's Activity hint assertion gains
`Ctrl+F pause fleet`.

**Acceptance criteria.**
- `Ctrl+F` toggles the fleet pause marker through `pauseFleet`/`resumeFleet`; no new state is
  introduced — the presence of the existing marker is what the scheduler, `tumwater status` and
  the GUI read.
- The flash carries the shared `fleetPausePhrase`/`fleetResumePhrase` wording; a toggle that
  changes nothing flashes the `already paused`/`was not paused` line, the CLI's changed-state
  contract.
- The next render shows the fleet-pause alert when the marker is set and drops it when lifted;
  the per-loop `Ctrl+P` and its fleet-pause interplay note are unchanged.
- `Ctrl+F` is inert while the budget editor or the role-prompt editor holds the prompt line.
- docs/how-it-works.md names the key, and `npm run test` is green.

### A Pending view in `tumwater tui` matching `tumwater diff` (planned 2026-10-10 by plan; sibling of the just-landed "A History view in `tumwater tui`"; independent of the Agent backends series; done 2026-10-10 by feature)

**Goal.** `Ctrl+T` in `tumwater tui` gains a fleet-wide **Pending** pane showing the unlanded-change
roster `tumwater diff` prints — one line per loop holding work, or `no pending changes` — so the
terminal can read what each loop holds between its commit and its merge without leaving the TUI.
This is the last view parity gap: `docs/how-it-works.md`'s Operator notes already say the TUI
"names its views the same way" and list only Activity, Transcript, Backlog, Usage, Failures, and
History, while the dashboard has a Pending view (PLANS.md ## Done, "GUI Pending view",
commit 5ecdaaa6) and the just-landed TUI History entry noted the dashboard's History "(and
Pending)" had no terminal counterpart. The pane reuses the existing collector and renderer —
`collectFleetChanges` (src/change/change-data.ts) and `renderFleetChange` (src/change/change-render.ts)
— so the TUI, the CLI, and `/api/diff` cannot disagree about the roster.

**Context.** The Usage/Failures/History panes are the template: a text cache `paneCache` computed
once per activation by the `Ctrl+T` handler (src/ui/tui/tui-keys.ts) and re-windowed each frame by
`paneBody` through `entryBodyWindow` (src/ui/tui/tui-pane.ts). History's read is synchronous;
`collectFleetChanges` is async (it awaits git plumbing behind `collectRoleChange`), so the Pending
branch kicks the collector off fire-and-forget from the sync handler, caches the rendered text when
it resolves, and calls `deps.requestRender()` — guarding on the view index so a resolution after the
operator cycled away cannot overwrite the new pane's cache. This is the same async-collector call
the GUI's `/api/diff` makes, reached directly rather than over HTTP.

**Approach.**
1. src/ui/tui/tui-frame.ts: add `{ kind: "pending" }` to `TuiView`; append `["pending", "Pending"]`
to `tabStrip`'s tab list **after** History, so the existing Usage/Failures/History indices and
their tests do not move; give `hintLine` a Pending branch with the Usage/Failures/History keys
(`Enter send · ↑↓ history · PgUp/PgDn scroll · Ctrl+T next view · Ctrl+D quit`); update the
`TuiView` and `tabStrip` doc comments to name Pending.
2. src/ui/tui/tui-pane.ts: a `pane.kind === "pending"` branch mirroring the history branch —
window `state.paneCache` through `entryBodyWindow(state.paneCache ?? "", state.paneScroll,
eventBudget, width)` and return `emptyNote: "(loading pending changes…)"` (the cache is null only
until the collector resolves); enumerate Pending in the module header comment.
3. src/ui/tui/tui-keys.ts: (a) change the cycle modulus to `roleIds.length + 6` and the pending
index to `roleIds.length + 5`, updating the cycle comment; (b) add an optional seam
`collectPending?: (root: string) => Promise<FleetChangeView>` to `TuiKeysDeps`, defaulting to
`collectFleetChanges` (imported from src/change/change-data.ts); (c) in the `Ctrl+T` handler, when
the new view is the pending index, leave `paneCache` null and `void deps.collectPending(root).then`:
if `view === roleIds.length + 5` still holds, set `paneCache = renderFleetChange(fleet)` (import
`renderFleetChange` from src/change/change-render.ts; name the resolved `FleetChangeView`
parameter `fleet`, since `view` is the handler's own view index) and call `deps.requestRender()`; on rejection
call `flashError(err)` and `deps.requestRender()` (the default collector's doc promises it degrades
rather than throws, so this only covers an injected seam). The existing `paneScroll = 0` reset and
the `view >= roleIds.length + 2` PgUp/PgDn condition already cover the new pane.
4. src/ui/tui/tui.tsx: map `view === roleIds.length + 5` to `{ kind: "pending" }` in the pane
assembly.
5. docs/how-it-works.md's Operator notes TUI bullet: add Pending to the `Ctrl+T` cycle sentence
(Activity, each loop's Transcript, Backlog, Usage, Failures, History, Pending).

**Files touched.**
- src/ui/tui/tui-frame.ts (`TuiView`, `tabStrip`, `hintLine`, comments)
- src/ui/tui/tui-pane.ts (`paneBody`, comment)
- src/ui/tui/tui-keys.ts (cycle modulus, `collectPending` seam, async pending cache)
- src/ui/tui/tui.tsx (view mapping)
- docs/how-it-works.md

Tests: extend test/tui-frame.test.ts's tab-strip and hint assertions for the Pending tab last;
extend the view-cycle test in test/tui-keys.test.ts to reach the pending index and page it, and add
one test that injects a `collectPending` resolving a fixed `FleetChangeView` — after the promise
settles the pane's `paneCache` is `renderFleetChange`'s text and a render was requested, and
cycling away drops the cache.

**Acceptance criteria.**
- `Ctrl+T` cycles Activity → each loop's Transcript → Backlog → Usage → Failures → History →
Pending → Activity, and the tab strip shows `[Pending]` last.
- The Pending pane shows the fleet-wide `renderFleetChange(await collectFleetChanges(root))` text:
one line per role holding unlanded work (`role: N commits ahead of <main>[, M uncommitted files]`),
or `no pending changes` when the fleet holds none; entering the pane recomputes it and the pane
repaints when the collector resolves.
- PgUp/PgDn page the pane and clamp at both ends, exactly as Usage/Failures/History page their
text; leaving the pane before the collector resolves does not cache onto the view the operator
moved to.
- `tumwater diff`, `tumwater diff --json`, the GUI Pending view, and `tumwater history` are
unchanged (`collectFleetChanges`, `renderFleetChange`, and `TickRow` are untouched).
- `npm run test` green.


### Agent backends, part 4b/7: `agent`, selector routing and per-tier claude defaults (planned 2026-10-09 by plan; split 2026-10-09 by plan from part 4/7; requires part 4a/7 landed; done 2026-10-10 by feature)

Design: plans/agent-backends.md ("Config: `agent`, `agents`, and backend-namespaced selectors";
"Decisions" 5).

Goal: claude becomes selectable.

**Approach.**
1. **`agent`.** Add `agent?: "pi" | "claude"` (default `"pi"`) to src/config/config-schema.ts
   and `defaultConfig()`.
2. **Routing.** A pure helper beside `parseModelSelector` in src/config/model-selector.ts
   resolves a `ModelSelector` plus `agent` to a backend id and, when no model is set, that
   backend's tier default. `withModelOverrides` in src/config/config-views.ts uses it to set
   `ResolvedModelConfig.agent`: the provider segment is a registered agent id → that agent; any
   other provider → pi; a bare id → top-level `agent`; no `model` key at all → the backend's
   tier default from `AGENT_DEFAULT_MODELS` below. Once `model` is set, today's tier
   inheritance is unchanged.
   `configForRole`, `reviewRunConfig`, `reviewConfig`, `resolverConfig` and the fallback views
   (`fallbackRoleConfig`) all carry the resolved `agent`.
3. **Defaults.** The tier-default table lives in src/config/model-selector.ts as
   `AGENT_DEFAULT_MODELS`, read by `routeModel` (the pure config layer resolves seam models and
   must not import the runtime backend registry): claude supplies `small: claude-haiku-5-5`,
   `default: claude-sonnet-5-5`, `strong: claude-opus-5-5`, pi none. They stay out of
   `defaultConfig()`, so a config that never set `model` does not grow a model key.
4. **Free-ness.** `fallbackModelFree` and `fleetModelsFree` (src/pi/pi-models.ts) consult the
   backend a selector routes to. In this part a claude-routed selector is never free, matching
   the safe direction `pairFree` already takes for an unresolvable pair; part 6/7 makes
   subscription billing free. The budget gate (src/gates/budget-gates.ts) and the status pause
   set (src/status/status-data.ts) judge fallback pairs with the same predicate, so neither
   engages a claude-routed fallback the badge would not call free.

**Files touched.** src/config/config-schema.ts, model-selector.ts, config-views.ts, config.ts;
src/agent/claude/claude-backend.ts; src/pi/pi-models.ts; src/gates/budget-gates.ts,
src/status/status-data.ts.

**Acceptance criteria.**
- **One line.** `{ "agent": "claude" }` runs author ticks on fake-claude with
  `--model claude-sonnet-5-5`, the reviewer/plan/conflict-resolver with
  `--model claude-opus-5-5`, and readme with `--model claude-haiku-5-5`;
  `{ "agent": "claude", "model": "claude-sonnet-5-5" }` puts every seam on Sonnet.
- **Mixed.** `{ "agent": "claude", "fallback": "omlx/Qwen…" }` runs the fallback on fake-pi
  with `--provider omlx`.
- **Per-seam.** `{ "review": { "model": "claude/claude-opus-5-5:high" } }` under `agent: "pi"`
  runs only the reviewer on claude, with `--effort high`.
- **Legacy.** A config with `agentBin` + `piArgs` and no `agent`/`model` produces byte-identical
  pi argv.
- **Free-ness.** A claude-routed `fallback` is rejected as not free, exactly like a priced pi
  pair.
- `npm run test` green.

Note (2026-10-10 by feature): the tier-default table lives in
src/config/model-selector.ts as `AGENT_DEFAULT_MODELS` and is the single source; `routeModel`
reads it directly because the pure config layer resolves seam models and must not import the
runtime backend registry, so `AgentBackend` carries no tier-default field. The config field is
typed `string` and validated against the reserved `AGENT_IDS` (`pi`, `claude`) so a test or
later backend can register an id outside the schema's set. Doctor's model sweep is not
agent-aware yet — a claude-routed config is read there as a bare pi model until part 4e/7.

### Agent backends, part 4a/7: the `agents` config section, legacy mapping, reserved flags and writers (planned 2026-10-09 by plan; split 2026-10-09 by plan from part 4/7, which feature judged too large for one run; requires part 3d/7 landed; done 2026-10-09 by feature)

Design: plans/agent-backends.md ("Config: `agent`, `agents`, and backend-namespaced selectors", "Back-compat").

Stores the backend section only; routing lands in part 4b/7, so this part adds no seam behavior.

**Approach.**
1. **Schema.** `agents?: Record<string, { bin?: string; args?: string[] }>` sits in
   src/config/config-schema.ts beside `agentBin`/`piArgs` (with an `AgentConfig` type and
   `AGENT_KEYS`), and `defaultConfig()` in src/config/config.ts gains an empty `agents` map.
   The effective `agents.pi` reads the legacy `agentBin`/`piArgs` through config-views.ts's pure
   `resolvedAgentConfig` — read, not written back into `config.agents`, because a load-time
   mirror would leak a duplicate spelling into every later config write that re-serializes the
   merged config.
2. **Validation.** src/config/config-validation.ts (with the helpers in config-field-checks.ts)
   accepts an `agents` entry only as an object with an optional non-empty `bin` string and an
   optional string `args` array; setting both spellings of one field (`agentBin` and
   `agents.pi.bin`, `piArgs` and `agents.pi.args`) is an error on the raw-file pass;
   `agents.claude.args` and `agents.pi.args` elements that repeat a harness flag
   (`HARNESS_CLAUDE_FLAGS`, exported by src/agent/claude/claude-args.ts, and `HARNESS_PI_FLAGS`)
   error exactly as `piArgs` does, naming the flag.
3. **Writers.** `agents.<id>.bin` and `agents.<id>.args` join config-write.ts's dotted-key merge
   logic (one field at a time, as `maxDailyCostUsdPerRole.<id>` merges one entry); the new-form
   pi setters drop the legacy alias and a legacy `agentBin`/`piArgs` set drops the matching new
   field, so a file never holds both. `EDITABLE_CONFIG_KEYS` gains the whole `agents` section,
   which the GUI settings mirror (src/ui/gui/gui-client-settings.ts) edits as JSON.
4. **Examples.** tumwater.example.json shows `agents`; the schema and resolver doc comments note
   that `agentBin`/`piArgs` are its legacy spelling.

**Files touched.** src/config/config-schema.ts, config-validation.ts, config-write.ts,
config-editable-keys.ts, config.ts, config-views.ts, config-example.ts;
src/cli/config-commands.ts; src/agent/claude/claude-args.ts;
src/ui/gui/gui-client-settings.ts; tumwater.example.json; test/config-validation.test.ts,
test/config-write.test.ts, test/config-views.test.ts, test/gui-client-settings.test.ts,
test/gui-endpoints.test.ts.

**Acceptance criteria.**
- **Legacy.** A config with `agentBin` + `piArgs` and no `agents` resolves those values under
  `agents.pi` through `resolvedAgentConfig`; the pi backend's resolved bin and argv stay
  byte-identical to before (the seams still read `agentBin`/`piArgs`).
- **Both forms.** Setting `agentBin` and `agents.pi.bin`, or `piArgs` and `agents.pi.args`, is a
  load-time validation error (the raw pass — the merged config always carries a default
  `piArgs`, so only the file's own keys can tell an explicit legacy value from the default).
- **Reserved.** `agents.claude.args: ["--model", "x"]` is a validation error naming the flag.
- **Writers.** `tumwater config set agents.claude.args '["--debug"]'` writes the array and
  `tumwater config set agents.claude.bin /opt/claude` the string (each merges one field);
  `config unset` removes them.
- **Inert.** No seam reads `agents` yet: selection and spawning are unchanged.
- `npm run test` green.

### Scope the usage report to one role: `tumwater report --role <id>` (planned 2026-10-09 by plan; done 2026-10-09 by feature; completes Stage 2 of docs/feature-per-role-spending.md; independent of the Agent backends series)

**Goal.** `tumwater report --role <id> [--days N]` and `tumwater report --role <id>
--since <duration>` (text and `--json`) report only that role's interactive usage and landed
commits, so an operator running per-role caps (`maxDailyCostUsdPerRole`, already landed) can
see where one role's spend went without eyeballing the fleet's per-role lines. This is the last
unlanded piece of docs/feature-per-role-spending.md's Stage 2: the per-role cap and the
dashboard's per-role cost already exist; only the scoped report is missing. Explicitly out of
scope here: scoping the failure digest and the dashboard/TUI report views, which keep their
fleet-wide data. The failure digest was scoped separately by the entry "Scope the failure
digest to one role: `tumwater report --failures --role <id>`" (done 2026-10-10), which removed
the `--role`/`--failures` rival-shape rejection.

**Approach.**
1. **Per-role output tokens.** In src/report/report-data.ts `foldUsageEvent`'s `tick_end`
branch, add `addTo(target.tokensByRole, role, tokens)` beside the existing `ticksByRole` and
`costByRole` bumps; add `tokensByRole: Record<string, number>` to `UsageFold` and `DayFold`,
initialized to `{}` in `dayFoldFor` and in `collectReportSince`'s accumulator. The map stays off
`ReportDay`/`SinceReport`, so no existing data-shape assertion changes.
2. **Scope both collectors.** Give `collectReport(root, days, role?)` and
`collectReportSince(root, sinceMs, role?)` an optional `role`. When set, each day/accumulator
derives its numbers from the fold's per-role maps instead of the fleet fields: `tokensOut`,
`costUsd`, `ticksByRole`/`costByRole`/`commits`/`commitsByRole` narrowed to that role's base —
instance keys fold into their group, matching the base-role cap — the work/maintenance split
from `commitTier(base)`, and
the landing fields plus `featuresDone`/`bugsFixed` left at zero (landing runs belong to the
landing slot, and backlog tallies are day-granular file dates with no role). Both payloads gain
`role?: string`; the fleet callers (src/report/report.ts, src/ui/tui/tui-keys.ts,
src/gui/gui-endpoints.ts) pass no third argument and are unchanged.
3. **CLI.** src/report/report.ts calls `parseRoleScope(root, args)` (src/cli/cli-args.ts — the
existing read-only role-id validator, custom loops included) and passes it to the collectors;
`--role` with `--failures` failed through the existing `failRivalShapes` wording (usage-report
scoping only) at the time; the failure-digest scoping entry removed that guard on 2026-10-10.
src/cli.ts's `case "report"` `rejectUnknownArgs` spec gains `ROLE_FLAG`;
src/cli/help.ts adds `[--role <id>]` to the `--days` and `--since` stanzas.
4. **Render.** In src/report/report-render.ts, when `data.role` is set: print a `role: <id>` line
under the window line; pass an empty tail to `totalsLine` in `renderReportMarkdown` so the fleet
`features done / bugs fixed` cells are dropped; and print one shared module constant (e.g.
`ROLE_SCOPE_NOTE`) to both renders naming that landing runs and backlog tallies are fleet-wide
and omitted. The landing-share line already disappears (zero means absent), and the fleet render
paths — including the TUI Usage pane and `/api/report` — are untouched.

**Files touched.**
- src/report/report-data.ts (fold maps; optional `role` on both collectors)
- src/report/report-render.ts (`role` line, scoped totals tail, `ROLE_SCOPE_NOTE`)
- src/report/report.ts (`parseRoleScope`, pass `role`, `--failures` rival)
- src/cli.ts (report gate admits `--role`)
- src/cli/help.ts (usage)

Tests: test/report-data.test.ts — scoped day and `--since` collectors over a two-role event set
(only the named role's tokens/ticks/cost/commits, landing and backlog cells zero), plus the same
fixture without `role` still totalling all roles; test/report.test.ts — the scoped render omits
the backlog tail and prints the scope note, `runCli(root, "report", "--role", "feature")` prints
only that role, `--role bogus` fails with the shared unknown-role message, `--role feature
--failures` failed as rival shapes at the time (that guard was removed 2026-10-10 when the
failure digest gained `--role`), a trailing `--role` names the missing-value error, and
`report --help` names the flag.

**Acceptance criteria.**
- `tumwater report --role feature --days 14` totals and every day row count only `feature`'s
`tick_end` tokens/ticks/cost and `feature`'s `merged` commits; the Ticks/Cost/Commits by role
lines name only `feature`; the header carries `role: feature` and the report states that landing
runs and backlog tallies are omitted; no landing-share line prints.
- `tumwater report --role feature --since 90m` does the same over the trailing window, and
`--json` carries `"role": "feature"`.
- `tumwater report` (text and `--json`) without `--role` is unchanged — every existing
report-data and report render test passes without edits.
- `tumwater report --role feature --failures` failed with a rival-shape error naming both flags
at the time (the guard was removed 2026-10-10 when the failure digest gained `--role`);
`--role bogus` fails with the shared unknown-role message; `tumwater help report` names `--role`.
- `npm run test` green.

### Show backlog entry eligibility holds in the GUI and TUI backlog lists (planned 2026-10-09 by plan; done 2026-10-09 by feature; sibling of "Mark why a backlog entry is held in `tumwater backlog`")

**Goal.** The dashboard's backlog panel and the TUI's project-status pane mark each held entry
beside its title with the same `[blocked: requires …]`, `[refused]`, `[needs review]`, or
`[needs replan]` tag `tumwater backlog` prints, so an operator watching the dashboards reads why
a plan or bug is skipped instead of inferring it from its heading text — the terminal and the
browser show the same thing both read in `tumwater backlog`.

**Context.** `entryHold`, `holdMark` and `backlogHolds` (src/backlog/backlog-eligibility.ts)
are the one decision every surface should share; today only the CLI uses them (`cli-query-
commands.ts` spreads `backlogHolds` into `backlogPayload`). `statusPayload`
(src/ui/status-payload.ts) exposes bare `plans`/`bugs` title arrays, so the GUI list
(`renderBacklog`, src/ui/gui/gui-client-fleet.ts) prints `splitTitle(title).title` unmarked. The
TUI backlog pane (`paneBody`'s backlog branch, src/ui/tui/tui-pane.ts) and its helpers
(`labeledBacklogEntries`, `backlogLines`, src/ui/tui/tui-backlog.ts) read
`plannedPlanEntries`/`openBugEntries` and print `e.title` unmarked in both list and entry mode.
No new collection or state: the marks are already computed from the headings.

**Approach.**
1. src/ui/status-payload.ts: read `backlogHolds(root)` once and add two arrays parallel to
today's `plans` and `bugs` — `planHolds: string[]` and `bugHolds: string[]`, each
`holdMark(holds.plans[i])`/`holdMark(holds.bugs[i])` (empty string when eligible). The arrays
stay aligned because `backlogHolds` and `plannedPlans`/`openBugs` both walk the same
`sectionEntries` file order.
2. src/ui/gui/gui-client-fleet.ts `renderBacklog`: for the plans and bugs tabs, read the
matching `d.planHolds`/`d.bugHolds` entry and, when non-empty, append
`<span class='li-meta'>` + `esc(mark.trim())` inside the entry's `<button class='li-open
backloglink'>` after the title span — the title/meta split and the click's `data-file` /
`data-index` are unchanged, and the questions tab carries no holds.
3. src/ui/tui/tui-backlog.ts: add an exported `backlogMarks(root): { plans: string[]; bugs: string[] }`
that maps `plannedPlanEntries`/`openBugEntries` through
`holdMark(entryHold(e, plannedEntries))` exactly as `backlogHolds` does; give each
`labeledBacklogEntries` row a `mark: string` field from it (empty for questions).
`backlogLines` keeps its `string[]` signature and tests.
4. src/ui/tui/tui-pane.ts backlog branch: pass `entry.title + marks.plans[i]` (and the bug
equivalent) into `backlogLines` for list mode, and `${e.label}: ${e.title}${e.mark}` for the
entry-mode header line, so both modes read the mark.

**Files touched.**
- src/ui/status-payload.ts (`planHolds`, `bugHolds`)
- src/ui/gui/gui-client-fleet.ts (`renderBacklog`)
- src/ui/tui/tui-backlog.ts (`backlogMarks`, `labeledBacklogEntries`)
- src/ui/tui/tui-pane.ts (`paneBody` backlog branch)

Tests: a case in test/status-payload.test.ts seeding PLANS.md/BUGS.md with a blocked and a
refused entry and asserting `planHolds`/`bugHolds` align with `plans`/`bugs`; a case in
test/gui-client-fleet.test.ts rendering `renderBacklog` with `planHolds` and asserting the tag
rides beside the title while an eligible row is byte-identical to today's; cases in
test/tui-backlog.test.ts for `backlogMarks` and the entry-mode header line.

**Acceptance criteria.**
- `GET /api/status` returns `planHolds` and `bugHolds` parallel index-for-index with `plans`
  and `bugs`; an eligible entry's mark is the empty string.
- The GUI Plans/Bugs tabs show `[blocked: requires …]` beside a blocked entry's title and the
  refusal/needs-review/needs-replan tags beside those, with eligible rows and the Questions tab
  unchanged; clicking a held row still opens its entry by index.
- The TUI backlog list and entry mode show the same mark beside the same title, and an eligible
  entry's line is unchanged.
- `tumwater backlog` output is unchanged (the mark functions are untouched).
- `npm run test` green.

### A History view in `tumwater tui` matching `tumwater history` (planned 2026-10-09 by plan; done 2026-10-09 by feature)

**Goal.** `Ctrl+T` in `tumwater tui` gains a fleet-wide **History** pane showing the completed-tick
rows `tumwater history` prints, newest first — the same rows the dashboard's History view renders —
so the terminal can read each loop's recent results, durations, and usage without leaving the TUI.
Today `TuiView` (src/ui/tui/tui-frame.ts) has Activity, Transcript, Backlog, Usage and Failures;
the dashboard's History (and Pending) have no terminal counterpart, so `docs/how-it-works.md`'s
claim that the TUI "names its views the same way" is not yet true. No new collection:
`readTickRows` (src/history/history-data.ts) already builds these rows for the CLI and
`/api/history`; this only renders them.

**Context.** The Usage/Failures panes are the template: their body is a text cache `paneCache`
computed once per activation by the `Ctrl+T` handler (src/ui/tui/tui-keys.ts) and re-windowed each
frame by `paneBody` through `entryBodyWindow` (src/ui/tui/tui-pane.ts). History is the same shape,
with `readTickRows(root, HISTORY_DEFAULT_TICKS, null)` as the per-activation read
(`HISTORY_DEFAULT_TICKS` is exported from history-data.ts). The CLI's column padding lives in
src/history/history.ts and is not pulled over: the pane has no full terminal width to align
against, so its one-line-per-row format is compact and the parity claim is about the rows and
fields, not byte-identical layout.

**Approach.**
1. New `tui-history.ts` (in src/ui/tui/): `historyPaneText(rows: readonly TickRow[]): string`,
one line per row — `time`, `loop #tick`, result, duration, usage, detail — omitting empty
`usage`/`detail`, rendering `—` for a null `durationMs` (reusing `shortSpanPhrase` from
src/text/phrases.ts), and `""` for no rows. Result is the `TickRow.result` string verbatim, so
the pane never reclassifies what history-data.ts resolved.
2. src/ui/tui/tui-frame.ts: add `{ kind: "history" }` to `TuiView`; append `["history",
"History"]` to `tabStrip`'s tab list after Failures, so the existing usage/failures indices and
their tests do not move; give `hintLine` a History branch with the Usage/Failures keys (`Enter
send · ↑↓ history · PgUp/PgDn scroll · Ctrl+T next view · Ctrl+D quit`).
3. src/ui/tui/tui-pane.ts: a `pane.kind === "history"` branch that windows `state.paneCache`
through `entryBodyWindow(state.paneCache ?? "", state.paneScroll, eventBudget, width)` and
returns `emptyNote: "(no ticks yet)"`; enumerate History in the module's header comment.
4. src/ui/tui/tui-keys.ts: change the cycle modulus to `roleIds.length + 5`, add the history
index `roleIds.length + 4` to the `paneCache` ternary (`readTickRows(root,
HISTORY_DEFAULT_TICKS, null)` → `historyPaneText`), and update the cycle comment. The existing
PgUp/PgDn condition (`view >= roleIds.length + 2`) and `stepEntryScroll` already page it.
5. src/ui/tui/tui.tsx: map `view === roleIds.length + 4` to `{ kind: "history" }` in the pane
assembly.
6. docs/how-it-works.md's Operator-notes TUI bullet: name History in the `Ctrl+T` cycle.

**Files touched.**
- `tui-history.ts` (new, in src/ui/tui/)
- src/ui/tui/tui-frame.ts (`TuiView`, `tabStrip`, `hintLine`)
- src/ui/tui/tui-pane.ts (`paneBody`)
- src/ui/tui/tui-keys.ts (cycle modulus, `paneCache`)
- src/ui/tui/tui.tsx (view mapping)
- docs/how-it-works.md

Tests: a new `tui-history.test.ts` under test/ for `historyPaneText` (a seeded `TickRow` renders
every field; a null `durationMs` shows `—`; an empty `usage` is omitted; no rows → `""`); update
test/tui-frame.test.ts's tab-strip and hint assertions for the new History tab; extend
test/tui-keys.test.ts's view-cycle test to reach `roleIds.length + 4` and page it.

**Acceptance criteria.**
- `Ctrl+T` cycles Activity → each loop's Transcript → Backlog → Usage → Failures → History →
Activity, and the tab strip shows `[History]` last.
- The History pane shows the newest `HISTORY_DEFAULT_TICKS` completed ticks from
`readTickRows(root, HISTORY_DEFAULT_TICKS, null)`, one per line: the row's time, `loop #tick`,
result, duration (or `—`), usage, and detail.
- PgUp/PgDn page the pane and clamp at both ends, exactly as Usage/Failures page their Markdown;
a log with no completed ticks shows `(no ticks yet)`.
- `tumwater history`, `history --json`, and the GUI History view are unchanged (their renderers
and `TickRow` are untouched).
- `npm run test` green.


### Inspect a loop's notebook and next tick prompt in the TUI (planned 2026-10-09 by plan; done 2026-10-09 by feature; sibling of "Inspect a loop's notebook and next prompt in the dashboard drawer")

**Goal.** Viewing a loop's transcript in `tumwater tui` gains a notebook view: `Ctrl+N`
switches the viewed loop's pane between its live transcript and a read-only snapshot of its
notebook and next tick's assembled prompt — the same two things the dashboard drawer shows, so
the terminal and the browser diagnose a quiet, stuck, or oddly-behaving loop the same way.

**Context.** `rolePayload` (src/roles/role-view.ts) already collects both: `note` is the loop's
notebook read from `roleNotesPath`, and `nextPrompt` is the next tick's assembled prompt through
the preview seam. The dashboard drawer reaches them through `handleRole` (`GET /api/role`,
src/gui/gui-endpoints.ts). The TUI does not: `paneBody`'s transcript branch
(src/ui/tui/tui-pane.ts) only returns `readTranscript`, `TuiView`'s transcript variant
(src/ui/tui/tui-frame.ts) carries no note flag, and no key in the Ctrl+T cycle's handler
(src/ui/tui/tui-keys.ts) reaches `rolePayload`. `renderRoleMarkdown` (src/roles/role-render.ts)
already renders the Notebook and Next tick prompt fenced blocks for `tumwater role <id>`. This is
an observability gap only — no new collection, scheduling, or state.

**Approach.**
1. src/roles/role-render.ts: extract the Notebook and Next tick prompt blocks (the two
   `fencedOrNone` calls plus the "more waits" note) out of `renderRoleMarkdown` into an exported
   `inspectMarkdownLines(p: RoleViewPayload): string[]`; `renderRoleMarkdown` splices it back at
   the same position, producing the same lines in the same order.
2. src/ui/tui/tui-pane.ts: add `noteCache: string | null` to `TuiPaneState`, and an exported
   `roleInspectMarkdown(root, role): string` that returns
   `inspectMarkdownLines(rolePayload(root, role)).join("\n")`. In `paneBody`'s transcript branch,
   when the pane's new `note` flag is set, window `state.noteCache` through the existing
   `entryBodyWindow(state.paneScroll, eventBudget, width)` (bold lines starting `#`, like the
   usage/failures panes) instead of `readTranscript`, with emptyNote `(nothing to inspect yet)`.
3. src/ui/tui/tui-frame.ts: add `note: boolean` to `TuiView`'s transcript variant. `tabStrip`
   labels that tab `Notebook: <role> (<index>/<count>)` when `note`, else today's `Transcript: …`.
   `hintLine`'s transcript branch gains `["Ctrl+N", view.note ? "transcript" : "notebook"]`
   beside the existing per-loop keys.
4. src/ui/tui/tui-keys.ts: add `let noteMode = false; let noteCache: string | null = null;` and
   both fields to `TuiKeysState`. A Ctrl+N branch (guarded to a transcript view, out of
   budget-edit and role-prompt modes) toggles `noteMode`, computes
   `noteCache = roleInspectMarkdown(root, role)` inside try/catch (`flashError` on a throw, leaving
   the mode off), nulls it when leaving, and resets `paneScroll = 0` each way. The Ctrl+T handler
   resets `noteMode = false; noteCache = null` beside its `paneScroll = 0`. The PgUp/PgDn branch
   pages `noteCache` when `noteMode`, else `paneCache`.
5. src/ui/tui/tui.tsx: build the transcript pane as `{ kind: "transcript", role, index: view,
   count: roleIds.length, note: s.noteMode }`.
6. docs/how-it-works.md's TUI "Operator notes" bullet names `Ctrl+N` beside `Ctrl+R` as the
   transcript/notebook toggle.

**Files touched.**
- src/roles/role-render.ts (`inspectMarkdownLines`, `renderRoleMarkdown`)
- src/ui/tui/tui-pane.ts (`TuiPaneState.noteCache`, `roleInspectMarkdown`, `paneBody`)
- src/ui/tui/tui-frame.ts (`TuiView`, `tabStrip`, `hintLine`)
- src/ui/tui/tui-keys.ts (`noteMode`, `noteCache`, Ctrl+N, Ctrl+T, PgUp/PgDn, `state()`)
- src/ui/tui/tui.tsx (transcript pane)
- docs/how-it-works.md (Operator notes)
- test/tui-frame.test.ts (the transcript variant's new `note` field)
- test/tui-operator-keys.test.ts, test/tui.test.ts (hint-order assertions gain Ctrl+N)

Tests: a case in test/role-view.test.ts for `inspectMarkdownLines` (its two sections and the
"more waits" line, and that `renderRoleMarkdown` still contains them in place), and TUI cases
(test/tui-notebook.test.ts, following the `withTui` pattern of test/tui-role-prompt.test.ts)
that seed a loop notebook via `fs.writeFileSync(roleNotesPath(repo, role), …)` and a queued
prompt for that loop, pin the notebook/none-yet and toggle-back rendering, and page the body
with PgUp/PgDn.

**Acceptance criteria.**
- `Ctrl+N` on a loop's transcript replaces the live transcript with a **Notebook** heading and the
  loop's note, and a **Next tick prompt** heading and that loop's assembled prompt; the tab strip
  reads `Notebook: <role> (i/n)` and the hint line offers `Ctrl+N transcript`. A loop with no
  notebook renders the fenced `_(none yet …)_` placeholder from `inspectMarkdownLines`, not the
  transcript's `(no transcript yet)`.
- `Ctrl+N` again (or `Ctrl+T`, or `Esc`-free cycling away) restores the live transcript, and the
  pane's scroll is back at its head.
- PgUp/PgDn in notebook mode page the assembled text and clamp at both ends, exactly as the
  usage/failures panes page their Markdown.
- A `rolePayload` throw on entering notebook mode leaves the transcript shown and flashes
  `error: <message>`; the TUI does not exit.
- `renderRoleMarkdown(rolePayload(root, id))`'s output is unchanged by the extraction: the
  Notebook and Next tick prompt blocks and the "more waits" line appear in the same positions
  (pinned by the existing test/role-view.test.ts cases and the new `inspectMarkdownLines` case).
- `npm run test` green.

### Mark why a backlog entry is held in `tumwater backlog` (planned 2026-10-09 by plan; done 2026-10-09 by feature)

**Goal.** `tumwater backlog` and its `--json` show the same eligibility hold the loop prompts'
`<backlog-index>` already carries, so an operator can see why a planned feature or open bug is
not being taken — refused, needs review, needs replan, or blocked on a named prerequisite —
instead of inferring it from a fleet that looks idle.

**Context.** `entryHold` (src/backlog/backlog-eligibility.ts) already decides holds from a body's
note lines and a heading's `requires … landed` parenthetical against the still-planned entries,
and `holdMark` (src/backlog/backlog-structure.ts) already renders ` [refused]`,
` [needs review]`, ` [needs replan]`, ` [blocked: requires …]`. Today that mark is the prompt
block's private detail — `renderBacklogIndexBlock` is `holdMark`'s only caller, and the
operator's `backlogPayload`/`renderBacklogMarkdown` carry the entries verbatim with no hold. This
is an observability gap, not a new eligibility rule: nothing about scheduling changes.

**Approach.**
1. Move `holdMark` from src/backlog/backlog-structure.ts into src/backlog/backlog-eligibility.ts,
   exported beside `holdMark`'s `EntryHold`; backlog-structure imports it back unchanged, so the
   prompt index and the CLI share one wording.
2. Add `backlogHolds(root): { plans: EntryHold[]; bugs: EntryHold[] }` to
   src/backlog/backlog-eligibility.ts: read `plannedPlanEntries(root)` once, map each planned
   entry through `entryHold(entry, planned)` and each `openBugEntries(root)` entry through the
   same, so each array is parallel to `backlogPayload`'s `plans`/`bugs`. Questions carry no holds.
3. Widen src/backlog/backlog-render.ts's input to `BacklogView` (`BacklogPayload` plus optional
   `holds: { plans: EntryHold[]; bugs: EntryHold[] }`): `renderSection` appends
   `holdMark(holds?.[i])` to a plan's or bug's `### ` heading, and an absent `holds` array or a
   null hold leaves the heading exactly as today.
4. src/cli/cli-query-commands.ts's `cmdBacklog` thunk returns
   `{ ...backlogPayload(root), holds: backlogHolds(root) }`, so the `--json` document and the
   Markdown consume one collection exactly as they do now.
5. README.md's `tumwater backlog` row names the hold mark beside both the human and `--json`
   forms.

**Files touched.**
- src/backlog/backlog-eligibility.ts (`backlogHolds`, `holdMark`)
- src/backlog/backlog-structure.ts (`holdMark` import)
- src/backlog/backlog-render.ts (`BacklogView`, `renderSection`)
- src/cli/cli-query-commands.ts (`cmdBacklog` thunk)
- README.md (`backlog` row)

Tests: cases in test/backlog-eligibility.test.ts (a refused/needs-review/blocked entry and an
eligible one) and test/backlog-render.test.ts (the rendered headings, the unchanged no-holds
render, and the CLI `--json` holds).

**Acceptance criteria.**
- `tumwater backlog` prints a plan whose heading names a still-planned prerequisite as
  `### <title> [blocked: requires <series> <part>/<of>]`, a refused bug as `### <title>
  [refused]`, and an eligible entry's heading byte-identically to today.
- `tumwater backlog --json` gains `holds.plans` and `holds.bugs`, arrays parallel to
  `plans`/`bugs` (`null` for an eligible entry, the `EntryHold` value otherwise); every existing
  field is unchanged.
- `renderBacklogMarkdown(backlogPayload(root))` (no `holds`) renders today's document unchanged,
  so the existing render test stays green untouched.
- `backlogHolds` marks a **Refused**, **Needs review**, or **Needs replan** body line and a
  blocked heading, and leaves an eligible entry null.
- `npm run test` green.

### Inspect a loop's notebook and next prompt in the dashboard drawer (planned 2026-10-09 by plan; done 2026-10-09 by feature)

**Goal:** the browser dashboard's loop drawer gains a read-only **Notebook** section (what the
loop remembers between fresh sessions) and a collapsible **Next tick prompt** section (exactly
what its next tick will read). The operator can diagnose a quiet, stuck, or oddly-behaving loop
from the page they are already watching, without dropping to the terminal for
`tumwater role <id>`.

**Context.** `rolePayload` (src/roles/role-view.ts) already collects both: `note` is the loop's
notebook (`roleNotesPath`, capped at 4 KB) and `nextPrompt` is the next tick's assembled prompt
through the preview seam; `renderRoleMarkdown` (src/roles/role-render.ts) renders them for the
CLI. Neither reaches the dashboard: there is no `/api/role` route in src/gui/gui-server.ts's
route table, and src/ui/gui/gui-client-drawer.ts shows state, controls, current work, last
result, metrics, recent ticks, live transcript and the unlanded change, but no notebook and no
next prompt. This is an observability gap only — no new collection, scheduling, or state.

**Approach.**
1. Add `handleRole(q: URLSearchParams, res: http.ServerResponse, root: string): void` to
   src/gui/gui-endpoints.ts, beside `handleTranscript`: read `role` from the pre-parsed query,
   validate with `rejectBadRole(root, res, role)` (missing → `role required (valid ids: …)`,
   unknown → `unknown role …`, same shared wording and typo hint), then
   `sendJson(res, 200, rolePayload(root, role as string))`. Return the payload as fields; the
   drawer renders `note`/`nextPrompt` itself, and `renderRoleMarkdown` stays the CLI's renderer.
2. Register `"GET /api/role": (_req, res, target) => handleRole(target.searchParams, res, root)`
   in src/gui/gui-server.ts's route table (beside `GET /api/tick`).
3. In src/ui/gui/gui-client-drawer.ts add a cached view (`drawerRole`, keyed by role, with
   `loading`/`ok`/`error` states) fetched from `/api/role?role=` once when a loop opens and
   cleared by `closeDrawer`; `openLoop` and switching roles refetch. Add a `drawerRoleSection()`
   helper that renders `<h3>Notebook</h3>` with the note in a `<pre>` (escaped through `esc`), a
   muted `No notebook yet.` placeholder when `note` is null, and a `<details><summary>Next tick
   prompt</summary><pre>…</pre></details>` whose body is a muted `Nothing to run (empty inbox).`
   when `nextPrompt` is null. Paint it into its own `<div id='drawerrole'>` panel (added to
   `showDrawer`'s body and the `lastPaint`-clear lists), not the `paintPanel("drawermeta", …)`
   chain: the 1 s poll rewrites `drawermeta` whenever its countdown or tick-age text changes,
   and an innerHTML rewrite would collapse an opened `<details>`. `renderLoopDrawer` paints
   `drawerrole` in both the live and missing-role branches, so it renders for a role the fleet
   no longer has too. The panel's string is stable while its payload is unchanged, so
   `paintPanel` skips it and the disclosure stays open across polls.
4. docs/how-it-works.md "Operator notes": extend the dashboard paragraph's "Clicking a loop
   opens its details" clause to name the notebook and next-tick prompt.

**Files touched.**
- src/gui/gui-endpoints.ts (`handleRole`)
- src/gui/gui-server.ts (route table)
- src/ui/gui/gui-client-drawer.ts (fetch, cache, `drawerRoleSection`, render)
- docs/how-it-works.md (Operator notes clause)
- test/gui-endpoints.test.ts, test/gui-client-drawer.test.ts

Tests: in test/gui-endpoints.test.ts add a `handleRole` case seeding a role notebook and
asserting the 200 body matches `rolePayload`'s `note`/`nextPrompt` plus the two `rejectBadRole`
400s (missing role, unknown role). In test/gui-client-drawer.test.ts add a case opening a loop,
serving `/api/role`, and asserting the drawer renders the notebook text, then switching roles
and asserting the refetch shows the second loop's note (not the first's).

**Acceptance criteria.**
- `GET /api/role?role=<known id>` answers 200 with `rolePayload(root, id)` (`note` and
  `nextPrompt` included); a missing or unknown id answers the same 400 JSON `rejectBadRole` gives
  `/api/transcript`, and `rolePayload` is never called for it.
- Opening a loop whose notebook file is non-empty renders a **Notebook** section containing that
  text; a loop with no notebook (or an empty one) shows `No notebook yet.`
- The **Next tick prompt** section renders `nextPrompt` verbatim; a director with an empty inbox
  shows the nothing-to-run note instead.
- Switching the open drawer from one loop to another shows the new loop's notebook and prompt,
  not the previous loop's cached text.
- A status poll that rewrites `drawermeta` (its tick-age text changes) does not repaint the
  `drawerrole` panel, so an opened **Next tick prompt** disclosure is not collapsed.
- `npm run test` green.


### Notify the operator when a loop posts a question (planned 2026-10-09 by plan; done 2026-10-09 by feature)

Design: this is the missing push half of the questions outbox. Loops ask the operator to decide
by merging an entry into QUESTIONS.md `## Open`; `tumwater questions`, the TUI/GUI backlog and the
fleet-alerts panel are all pull surfaces, and the `notify` hook — the one push channel — does not
fire for that event. The hook's own contract (src/events/notify.ts, config-schema.ts) already
covers "the states where only a human can act"; a posted question is exactly that state, so this
is an allowlist gap, not a new mechanism.

The event already exists and is already in scope for the notifier: `logNewQuestions`
(src/landing/landing-questions.ts) logs one `question_posted` per new Open heading through
`logEventBestEffort`, which calls `logEvent` and so reaches `newNotifier`'s `subscribeEvents`
listener in the orchestrator process.

**Approach.**
1. Append `"question_posted"` to `NOTIFY_EVENT_TYPES` in src/events/notify.ts.
2. Update that module's doc: "All seven allowlisted types" becomes eight, and its source list
   gains `landing-questions.ts` (the landing pipeline beside `landing-slot.ts`).
3. Update src/config/config-schema.ts's `notify` field doc and README.md's `notify` parenthetical
   to name a posted question among the paged events.

**Files touched.**
- src/events/notify.ts (allowlist entry, module doc)
- src/config/config-schema.ts (`notify` field doc)
- README.md (`notify` parenthetical)
- test/notify.test.ts

Tests: update the pinned literal array in `NOTIFY_EVENT_TYPES and NOTIFY_MIN_GAP_MS stay pinned
to the planned allowlist and gap`; add a spawn case mirroring `an allowlisted event spawns the
notify command once with the three env vars set` with a `question_posted` event (`{ loop: "feature",
question: "…" }`), asserting `TUMWATER_EVENT_TYPE=question_posted`, the posting role, and
`TUMWATER_EVENT_MESSAGE` equal to `formatEvent(event)`.

**Acceptance criteria.**
- A `question_posted` event logged in-process spawns the notify command once, with
  `TUMWATER_EVENT_TYPE=question_posted`, `TUMWATER_EVENT_LOOP` the posting role, and
  `TUMWATER_EVENT_MESSAGE` the rendered `question posted: <heading>` line.
- `NOTIFY_EVENT_TYPES` contains `question_posted`, and the pinned test asserts the updated
  literal array including it.
- A non-allowlisted event still spawns nothing (the existing negative test is unchanged and green).
- The `notify` docs in src/events/notify.ts, src/config/config-schema.ts and README.md name a
  posted question.
- `npm run test` green.

### Agent backends, part 3c3/7: backend-aware resumability across the loop (planned 2026-10-09 by plan; split 2026-10-09 by plan from part 3c/7; requires part 3c1/7 landed; done 2026-10-09 by feature)

Design: plans/agent-backends.md ("Sessions"). The conflict hand-back note on a handoff already
landed in loop-tick.ts (`if (handoff && s.conflictHandback?.applied)`), so this part is only the
resumability guards.

**Goal:** every resume and same-session guard asks the run's own backend whether its session is
resumable, so a claude author or gate run resumes through its ledger id instead of being read
as having no session (which would reset the worktree and lose the interrupted run's edits).

**Approach.**
1. **Session-file check moved.** `hasResumableSession` now lives in
   `src/agent/session-ledger.ts` (its filesystem check is backend-neutral: a `.jsonl` in the
   dir other than `SESSION_LEDGER_FILE`, which is no longer exported), and `src/pi/pi.ts`
   re-exports it so every existing importer and test is unchanged. Moving it avoids an import
   cycle: session-ledger.ts imports only files.ts, while pi.ts reaches run-agent.ts.
2. **Hook + dispatcher.** `src/agent/agent-backend.ts` adds optional `resumable?(dir: string,
   opts: { kind: string; agent: string; cwd?: string }): boolean` to `AgentBackend`, and exports
   `agentSessionResumable(dir, opts)` dispatching to `agentBackend(opts.agent)?.resumable`, or
   falling back to `hasResumableSession(dir)` when the backend is unregistered or has no hook.
3. **pi implementation.** `src/pi/pi-backend.ts`: `resumable(dir, opts)` =
   `sessionResumable(dir, opts, hasResumableSession(dir))`.
4. **claude implementation.** `claude-backend.ts` under src/agent/claude/: a shared
   `claudeResumableRecord` (newest record of the kind at the requested cwd whose transcript
   exists) backs both `resumable(dir, opts)` and the invocation's `--resume` choice, so the
   guard and the run cannot drift.
5. **Replace the same-session guards** with `agentSessionResumable`: `planTickStart`
   (src/tick/tick-resume.ts, passing `{ kind: "author", agent }` and no cwd, since it runs
   before the lease — the adapter's own cwd match in `invocation` stays the runtime second
   line), `requestFollowUp`'s guard (src/loop/loop-pi.ts), the review-follow-up guard
   (src/review/review-followup.ts), and the reviewer's two timeout-progressing resume guards
   (src/review/review.ts) — the original three-guard list missed review.ts, whose guards would
   otherwise read a claude gate run as having no session.
6. **Tests.** `test/tick-resume.test.ts` (a claude author resumes when its transcript exists,
   resumes its id past a newer gate line, and hands off when the newest line names another
   agent or its own transcript is gone — part 3d widened the latter from a worktree reset),
   `test/review-followup.test.ts`
   (a claude gate session resumes without a pi session file), and the adapter's `resumable`
   predicate in `test/claude-run.test.ts`. The entry named `test/loop-interrupted.test.ts`; the
   decision it targets is pinned directly in tick-resume.test.ts because planTickStart owns it
   and `loop-tick.ts` keeps the slot from `plan.resuming || plan.handoff` unchanged.

**Files touched:** `src/agent/agent-backend.ts`, `src/agent/session-ledger.ts`,
`src/pi/pi-backend.ts`, `src/pi/pi.ts`, `claude-backend.ts` under src/agent/claude/,
`src/tick/tick-resume.ts`, `src/loop/loop-pi.ts`, `src/review/review-followup.ts`,
`src/review/review.ts`, `test/tick-resume.test.ts`, `test/review-followup.test.ts`,
`test/claude-run.test.ts`.

**Acceptance criteria:**
- With `config.agent = "claude"` and a transcript present for the newest author ledger line,
  `planTickStart` sets `resuming: true` and the tick's slot is kept (`keep`); with the transcript
  absent it does not resume but hands off over the kept worktree (part 3d superseded the reset).
  A newest line naming another agent still hands off.
- A claude `requestFollowUp` and a claude review follow-up pass `--resume <recorded id>`; a pi
  session dir still uses pi's `--continue` exactly as today.
- A ledger line whose cwd differs from the requested cwd is not resumable.
- The project's check passes.

### Agent backends, part 3d/7: `resumeMissing` resumes as a `handoff` (planned 2026-10-09 by plan; split from part 3/7; requires part 3c3/7 landed; done 2026-10-09 by feature)

Design: plans/agent-backends.md ("Sessions").

**Approach.**
1. When a `--resume` run ends with `PiRunResult.resumeMissing` (part 3a), its error turn carries
   no assistant content, so `resolveTickVerdict` (src/tick/tick-verdict.ts) keeps the worktree and
   arms `resumePending` exactly as for any failed dirty run.
2. `planTickStart` (src/tick/tick-resume.ts) then sees the newest author ledger line as not
   resumable (`agentSessionResumable`, part 3c3/7 — its transcript is gone) and hands off
   instead of resetting: a FRESH session over the kept worktree whose prompt is
   `buildHandoffPrompt` (src/prompt/prompt-followup.ts) over the assembled tick prompt, and the
   `resume` event reports the `handoff` cause. The pre-3d rule only handed off for a newest
   line of another kind or agent; it now hands off for any newest line the run's own backend
   cannot resume, which is exactly the `resumeMissing` case.
3. The retry is deliberately NOT done inside `runWithTransientRetry` (src/loop/loop-pi.ts):
   every resume that can report `resumeMissing` runs a resume bridge or a follow-up prompt, not
   the tick prompt `buildHandoffPrompt` needs, so a fresh session there would get no task. The
   next tick is the first point the assembled tick prompt (including a reclaimed per-role
   request) is available, and the pinned slot keeps the interrupted edits until then.

**Files touched.**
- src/tick/tick-resume.ts
- test/tick-resume.test.ts

**Acceptance criteria.**
- A fake-claude run whose `--resume` id has no transcript yields `resumeMissing`; driven
  through `resolveTickVerdict` against a dirty worktree, the failed turn arms `resumePending`,
  and the next `planTickStart` hands off — a fresh session over the kept worktree with the
  assembled tick prompt plus the handoff bridge — rather than resetting.
- A newest author line whose session is resumable still resumes; a dir with no ledger line
  still falls back to a fresh tick.
- `npm run test` green.

### Agent backends, part 3c2/7: the claude native log and translator warnings (planned 2026-10-09 by plan; split 2026-10-09 by plan from part 3c/7; requires part 3c1/7 landed; done 2026-10-09 by feature)

Design: plans/agent-backends.md ("Canonical event stream": the native stream is kept for
debugging only); part 3a/7's `ClaudeStreamTranslator.warnings()` already collects the unmapped
native types and a result-less run's `cost_unknown`.

**Goal:** a claude run's raw stdout is kept beside the canonical log for debugging, and the
native shapes the translator could not map are visible in the event feed.

**Approach.**
1. **Path.** `src/paths.ts`: add `nativeLogPath(root, role, agent)` =
   `.tumwater/log/<role>.<agent>.native.jsonl`, beside `piLogPath`, documented as debug-only.
   Add `nativeLogFile: string` to `PiRunOptions` (src/agent/run-agent.ts) and pass it at the
   three `rawLogFile` construction sites: `loopPiOpts` in src/loop/loop-pi.ts, src/review/review.ts,
   src/review/review-followup.ts (each already computes `piLogPath(root, role)`, so the native
   path names the same agent the run actually uses).
2. **Write.** In `run-agent.ts`, open the native log like the raw log (`ensureParentDir` +
   `rotateIfLarge`); in `feedCanonical` write each complete native `line` to it before
   `translator.translate`. A broken native log is non-fatal exactly as `rawLogBroken` is.
3. **Warnings.** Add optional `warnings?(): string[]` to `StreamTranslator`
   (src/agent/agent-backend.ts); `ClaudeStreamTranslator` already has it. Add
   `onAgentWarning?: (warning: string) => void` to `PiRunOptions`; after the run, `run-agent.ts`
   forwards each `translator.warnings?.() ?? []` entry once. Wire it in `loopPiOpts` as
   `(w) => this.host.warn(`agent_unknown_event: ${w}`)`.
4. **Tests.** Extended `claude-run.test.ts` (native-log content, empty-native and result-less
   runs, rotation, and the warning callbacks) and added a loop-pi test that a claude run lands
   its native log at the role.agent path and surfaces `agent_unknown_event: …` through the host.

**Files touched:** `src/paths.ts`, `src/agent/run-agent.ts`, `src/agent/agent-backend.ts`,
`src/loop/loop-pi.ts`, `src/review/review.ts`, `src/review/review-followup.ts`,
`test/claude-run.test.ts`, `test/loop-pi.test.ts`, `test/pi.test.ts` (its stalled-stream raw-log
flush test now keys the injected stream by path, since a run opens two logs),
`src/agent/claude/claude-stream.ts` (warning comment), plus the test fixtures that construct
`PiRunOptions`.

**Acceptance criteria:**
- A fake-claude run writes its raw native lines to `.tumwater/log/<role>.claude.native.jsonl`
  and canonical lines to the raw log; a run with no native output writes none.
- The native file rotates under `logMaxBytes` the way the raw log does.
- A run with an unmapped native type and a result-less run each produce exactly one
  `agent_unknown_event` warning naming the type / `cost_unknown`; a fully-mapped run produces
  none.
- The project's check passes.

### Agent backends, part 3c1/7: the claude backend adapter and PATH fake (planned 2026-10-09 by plan; split 2026-10-09 by plan from part 3c/7, which feature judged too large for one run; requires parts 3a/7 and 3b/7 landed; done 2026-10-09 by feature)

Design: plans/agent-backends.md ("The seam", "Sessions", "Testing").

Registers claude as an adapter and proves a run end to end on a fake. Still not selectable from
tumwater.json (part 4/7); tests drive it through `runAgent` with `config.agent = "claude"`.
Parts 3c2/7 (native log and translator warnings) and 3c3/7 (backend-aware resumability across
the loop) build on this and require it landed.

**Goal:** `runAgent` runs claude on a fake and folds its stream exactly as it folds pi's, with a
per-run session ledger the loop's later resume paths can query by ledger id.

**Approach.**
1. **Seam additions.** `src/agent/agent-backend.ts`: add `kind: PiRunKind` to `AgentRunSpec`
   (the adapter needs it for the ledger and the translator); add `sessionId?: string` to
   `AgentInvocation` — the backend session id this run used (minted for a fresh claude run, the
   resumed record's id for a continue), absent for pi, which mints no id ahead of the run.
   `src/agent/run-agent.ts` records it: `recordSession(opts.sessionDir, { ..., id:
   invocation.sessionId ?? opts.sessionName, ... })`.
2. **Binary resolution.** `src/pi/pi-bin.ts`: extract `resolveBinFrom(binEnv, defaultBin,
   configured?)` from `resolveAgentBin` (pi keeps env → `config.agentBin` → `"pi"`); give
   `agentBinSourceLabel(source, binEnv = "TUMWATER_PI_BIN")` the env name so a spawn error names
   `TUMWATER_CLAUDE_BIN`; `run-agent.ts`'s `spawnErrorMessage` passes `backend.binEnv`.
3. **Adapter.** New `claude-backend.ts` in the claude adapter directory (src/agent/claude/) exporting `claudeBackend: AgentBackend`:
   `id: "claude"`, `label: "Claude Code"`, `defaultBin: "claude"`, `binEnv:
   "TUMWATER_CLAUDE_BIN"`, `resolveBin` via `resolveBinFrom`, and:
   - `invocation(run)`: pick the session id (step 4), then `claudeArgs({ cwd: run.cwd, model:
     run.config.model, thinking: run.config.thinking, sessionId | resumeSessionId, prompt:
     run.prompt })`; layer the environment as pi's adapter does —
     `runMarkerEnv(withoutLaunchServicesCheckIn(process.env), run.runMarker)` then
     `claudeEnv(base, { quietTimeoutSeconds: run.config.quietTimeoutSeconds })` (both modules
     landed in 3b/7). Throw a clear error when `run.config.model` is undefined, since part 4/7
     resolves the tier defaults. Return `{ args, stdin, env, sessionId }`.
   - `translator()`: `claudeTranslator()` from 3a/7.
   - `classifyExit(info)`: `{}` when `info.killed`; otherwise `{ configError: true }` when
     `info.code !== 0` and stderr matches
     `/Not logged in|issue with the selected model|does not support this model/i`, else `{}`.
     (The event path in claude-stream.ts classifies the stream itself; this is the stderr half.)
4. **Session decision.** In `invocation`, fresh (`!run.continueSession`): `randomUUID()` and pass
   it as `sessionId`. Continue: `resumableSession(run.sessionDir, { kind: run.kind, agent:
   "claude", cwd: run.cwd })`; resume with `resumeSessionId: record.id` only when the record
   exists and its transcript file exists, else mint a fresh id. Add
   `claudeTranscriptPath(cwd, id)` = `path.join(os.homedir(), ".claude", "projects",
   claudeProjectSlug(cwd), `${id}.jsonl`)` with `claudeProjectSlug(cwd) =
   cwd.replace(/[^A-Za-z0-9]/g, "-")`, exported so the fake and tests create the same file.
5. **Registration.** `run-agent.ts`: `registerAgentBackend(claudeBackend)` beside `piBackend`.
6. **Fake.** New `fake-claude.ts` under test/fakes/ on fake-pi.ts's conventions: a PATH shim named
   `claude` replaying canned stream-json, logging argv and stdin per run, and creating the
   transcript at `claudeTranscriptPath` under a temp HOME. `test/test-runner.ts`'s `suiteEnv`
   additionally deletes `TUMWATER_CLAUDE_BIN`, `CLAUDECODE`, and every `CLAUDE_CODE_*`.
7. **Tests.** New `claude-run.test.ts` under test/ driving `runAgent`.

**Files touched:** new `claude-backend.ts` under src/agent/claude/, `src/agent/agent-backend.ts`,
`src/agent/run-agent.ts`, `src/pi/pi-bin.ts`, new `fake-claude.ts` under test/fakes/,
new `claude-run.test.ts` under test/, `test/test-runner.ts`.

**Acceptance criteria:**
- `runAgent` on fake-claude with `config.agent = "claude"` and a set `config.model` returns the
  folded `PiRunResult` (cost from the final `result`), and the raw log holds canonical lines the
  existing readers render.
- A fresh run's argv carries `--session-id <uuid>`; the session ledger gains one line with that
  id, `agent: "claude"`, the run's kind and cwd; the fake created the transcript at the matching
  `claudeTranscriptPath`.
- A `continueSession` run from the same cwd and kind passes `--resume <recorded id>`; a ledger
  record whose cwd differs, or whose transcript file is absent, gets a fresh `--session-id`.
- The spawned env strips `CLAUDECODE` and `CLAUDE_CODE_SESSION_ID` even when the suite's parent
  carries them; stdin carries the prompt.
- `classifyExit` maps a nonzero exit with "Not logged in" stderr to `configError` and leaves a
  killed run unclassified.
- The project's check passes.

### A review retry picks up the timed-out reviewer's session, part 3/3: resumed-review event and failure digest (planned 2026-10-09 by operator; split from "A review retry picks up the timed-out reviewer's session instead of reviewing from scratch"; requires part 2/3 landed; done 2026-10-09 by feature)

Part 2/3 already writes the accurate `review_failed` message itself (its conditional `reviewTimeoutRewrite`); this part makes the event feed and the failure digest read the same way. It is separable because a missing `resumed` render or a digest cluster is a reporting gap, not a behavior change.

**Goal:** a resumed review is legible in the feed, and the failure digest clusters "continues this review" separately from "reviews it from scratch" so the top-loss ranking counts the two honestly.

**Approach.**
1. `src/events/event-format.ts`: the `review_start` case renders `review resumed <shortSha>` (with ` (revision N)` when `revision` is set) when the event's `resumed` flag is set, else the current `reviewing …` line.
2. `src/failure/failure-cluster.ts`: add the "the next attempt continues this review" pattern as its own cluster and keep the existing "reviews it from scratch" pattern, so old log lines still cluster where they did.
3. Tests: `test/event-format.test.ts` for the resumed line (flag set and unset), `test/failure-cluster.test.ts` for the two patterns.

**Files touched:** src/events/event-format.ts, src/failure/failure-cluster.ts, test/event-format.test.ts, test/failure-cluster.test.ts.

**Acceptance criteria:**
- A `review_start` event with `resumed: true` renders `review resumed <sha>`, adding ` (revision N)` when `revision` is set; without the flag it renders the current `reviewing …` line.
- The failure digest clusters the two timeout messages under distinct causes, and a line with only the from-scratch wording still clusters where it used to.
- The project's check passes.

- A review retry picks up the timed-out reviewer's session, part 2/3: record and resume a progressing-timeout review session (planned 2026-10-09, done 2026-10-09; commit 6f3f0f27)
- Retract a config value: `tumwater config unset <key>` (planned 2026-10-09, done 2026-10-09; commit 5be2d7ed)
- Edit an operator-filed backlog entry: `tumwater plan --edit <n>` and `tumwater bug --edit <n>` (planned 2026-10-09, done 2026-10-09; commit a2f09d37)
- A review retry picks up the timed-out reviewer's session, part 1/3: per-review session directories (planned 2026-10-09, done 2026-10-09; commit 9876cb8b)
- Agent backends, part 3b/7: the claude invocation and isolation environment (planned 2026-10-09, done 2026-10-09; commit 38c752f4)
- Agent backends, part 3a/7: the claude stream translator and canonical vocabulary (planned 2026-10-09, done 2026-10-09; commit 0694aadf)
- Cover failure-caused loop pauses and model fallbacks in the failure digest's Fleet state changes (planned 2026-10-09, done 2026-10-09; commit 91cddcfc)
- A trailing window for the failure digest: `tumwater report --failures --since <duration>` (planned 2026-10-09, done 2026-10-09; commit 3ea92811)
- Cancel an operator-filed backlog entry: `tumwater plan --cancel <n>` and `tumwater bug --cancel <n>` (planned 2026-10-09, done 2026-10-09; commit 209f1623)
- Agent backends, part 2/7: a session ledger and the `handoff` resume (planned 2026-10-09, done 2026-10-09; commit 9f15ccee)

- Agent backends, part 1/7: the `AgentBackend` seam, with pi as its only adapter (planned 2026-10-09, done 2026-10-09; commit f7931c9e)
- Split the LoopRunner tick pipeline out of src/loop/loop.ts (planned 2026-10-08, done 2026-10-09; commit 49659ce8)
- Parallel work instances, part 7/7: keep permit headroom for work loops that have work to take (planned 2026-10-07, done 2026-10-09; commit 09a8deac)
- Stop showing leased worktree slots in the TUI and GUI (planned 2026-10-09, done 2026-10-09; commit f5d3b41e)
- Work ratio, part 1b/4: the scheduler holds maintenance loops past their allowance (planned 2026-10-08, done 2026-10-09; commit 94a76b2f)
- Work ratio, part 1a/4: the maintenance allowance — window counts, the verdict and the `maintenancePerWorkLanding` setting (planned 2026-10-08, done 2026-10-08; commit d0918d6d)
- Work ratio, part 2/4: a clean tick sweeps one kind of drift across the tree instead of one site (planned 2026-10-08, done 2026-10-08; commit cd533c0a)
- Parallel work instances, part 6/7: show instances and claims on status, TUI, GUI, logs and doctor (planned 2026-10-07, done 2026-10-08; commit 11025166)
- Worktree pool, part 5/5: slot waits, slot display, doctor check and docs (planned 2026-10-06, done 2026-10-08; commit 4b3c4234)
- Worktree pool, part 4c/5: retire legacy role worktrees at orchestrator start (planned 2026-10-06, done 2026-10-08; commit a0da7193)

- New-project bootstrap, part 2/2: while bootstrapping, only plan, feature, director and bugfix-with-open-bugs tick (planned 2026-10-08, done 2026-10-08; commit d98c6e74)
- New-project bootstrap, part 1/2: `tumwater init` recognizes an empty project and opts it into bootstrap (planned 2026-10-08, done 2026-10-08; commit 7c5c12e8)
- Work ratio, part 3/4: the plan loop's "enough waiting" target counts only entries feature could take now (planned 2026-10-08, done 2026-10-08; commit 4f390088)
- Work ratio, part 4/4: report commits by role and show work vs maintenance commits on the "Landed today" tile and `tumwater report` (planned 2026-10-08, done 2026-10-08; commit 00b86b94)
- Parallel work instances, part 5c/7: the plan charter's target scales with `feature.instances` (planned 2026-10-08, done 2026-10-08; commit 84093966)
- Parallel work instances, part 5b/7: instance runners spawn at startup and on live reload, gated by claims (planned 2026-10-08, done 2026-10-08; commit f2f6c687)
- Parallel work instances, part 5a/7: the validated `roles.<id>.instances` config field and `loopIds` enumeration (planned 2026-10-08, done 2026-10-08; commit 7378fd27)
- Organize the test suite, part 6/6: remaining fixtures move to `test/fixtures/`, leaving the root clean (planned 2026-10-07, done 2026-10-08; commit a3da2cbe)
- Organize the test suite, part 5/6: log, loop, orchestrator and status fixtures plus `pi-events` and `victim-fixture` move to `test/fixtures/` (planned 2026-10-07, done 2026-10-08; commit f2effe3c)
- Organize the test suite, part 4/6: `repo-fixtures.ts` moves to `test/fixtures/` (planned 2026-10-07, done 2026-10-08; commit 53a7df79)

- Organize the test suite, part 3/6: harness and oracle modules move to `test/helpers/` (planned 2026-10-07, done 2026-10-08; commit 06a448fe)
- Organize the test suite, part 2/6: utility modules move to `test/helpers/` (planned 2026-10-07, done 2026-10-08; commit c5e9adc2)
- Organize the test suite, part 1/6: support fakes move to `test/fakes/` (planned 2026-10-07, done 2026-10-08; commit b3c98628)
- Worktree pool, part 4b/5: role ticks lease a pooled slot (planned 2026-10-06, done 2026-10-07; commit 69116eb7)
- Worktree pool, part 4a/5: a leased slot can be kept for its role's resume and pinned on release (planned 2026-10-06, done 2026-10-07; commit 0b4254bd)
- Worktree pool, part 2d/5: remove the `_land-*` machinery and legacy checkouts (planned 2026-10-06, done 2026-10-07; commit 67481cca)
- Worktree pool, part 2c/5: merge-side landing work uses one `_merge` checkout (planned 2026-10-06, done 2026-10-07; commit a953a20f)
- Worktree pool, part 2b/5: vets lease a pooled slot (planned 2026-10-06, done 2026-10-07; commit 0bc3e253)
- Worktree pool, part 2a/5: the slot pool and its `worktreeSlots` config (planned 2026-10-06, done 2026-10-07; commit 93961c83)
- Worktree pool, part 3/5: readers find a role's checkout through `roleWorktreeDir` (planned 2026-10-06, done 2026-10-07; commit 6a5300f8)
- Robust conflict landing, part 2/2: a conflict the resolver cannot settle goes back to its author with the markers in place, instead of being discarded (planned 2026-10-07, done 2026-10-07; commit abbd00b9)
- Parallel work instances, part 4/7: the harness assigns each multi-instance loop one backlog entry and holds the claim through landing (planned 2026-10-07, done 2026-10-07; commit ac06d62d)
- Parallel work instances, part 1/7: one role, several loop ids — normalize every catalog-role lookup through `baseRoleOf` (planned 2026-10-07, done 2026-10-07; commit ef2a1d1e)
- Parallel work instances, part 2/7: mark backlog entries blocked by an unlanded prerequisite, refused, or needing review (planned 2026-10-07, done 2026-10-07; commit 92323d23)
- Disk floor, part 3/4: reclaim long-idle worktrees, and a `tumwater reclaim` command (planned 2026-10-06, done 2026-10-07; commit 374c7cbd)
- Parallel work instances, part 3/7: insert-only conflicts in PLANS.md, BUGS.md and QUESTIONS.md resolve without a model run (planned 2026-10-07, done 2026-10-07; commit 1a9de531)
- `tumwater run --gui`: boot the engine and the browser dashboard from one command (planned 2026-10-07, done 2026-10-07; commit e9d1d35f)
- Replan a plan whose change used up its review rounds, instead of re-authoring the same plan from scratch (planned 2026-10-07, done 2026-10-07; commit 919d28ec)
- Disk floor, part 4/4: show free space, the disk hold and the last reclaim on status, TUI and GUI (planned 2026-10-06, done 2026-10-07; commit 9d7d050b)
- Robust conflict landing, part 1/2: the conflict resolver sees what both sides meant, not only the markers (planned 2026-10-07, done 2026-10-07; commit 0f7aca27)
- Disk floor, part 2/4: reclaim gitignored build outputs from idle worktrees when free space runs low (planned 2026-10-06, done 2026-10-07; commit c8dde7f0)
- Revise rejected changes, part 2/2: the re-review sees the prior objections and what the revision changed (planned 2026-10-06, done 2026-10-07; commit b85652c5)
- Revise rejected changes, part 1/2: a rejected change goes back to its author as uncommitted edits instead of being discarded (planned 2026-10-06, done 2026-10-07; commit 5d152f91)
- Disk floor, part 1/4: hold new work when the worktrees volume runs low on free space (planned 2026-10-06, done 2026-10-07; commit 6794835b)
- Worktree pool, part 1/5: label every pi run's kind and demultiplex progress by the label, not the lander path (planned 2026-10-06, done 2026-10-07; commit 243c0873)
- Pre-queue self-check, part 2/2: flag stale path references, nonexistent paths, and lost final newlines (planned 2026-10-06, done 2026-10-06; commit 72a87b77)
- Pre-queue self-check, part 1/2: run the gate's deterministic backlog checks before a tick queues, with one fix-up turn on the author's session (planned 2026-10-06, done 2026-10-06; commit 1bb38fd2)
- Fallback-window shake: reclaim old tool output instead of only warning when a small-window model fills (planned 2026-10-06, done 2026-10-06; commit 03f7f29d)
- Role notebook: carry a bounded, model-written note per role across fresh ticks (planned 2026-10-06, done 2026-10-06; commit 5b336bed)
- Model failure fallback, part 2/2: show the episode on every surface (planned 2026-10-06, done 2026-10-06; commit e5a1c8a4)

- Model failure fallback, part 1/2: run a failing role's ticks on its tier fallback (planned 2026-10-06, done 2026-10-06; commit 1859a3d5)
- Log one `model_changed` event when a live config edit changes the fleet's model wiring (planned 2026-10-06, done 2026-10-06; commit 41755952)
- Show each loop's active model on `tumwater status`, the TUI, and the GUI (planned 2026-10-06, done 2026-10-06; commit 2f9a1ad9)
- Per-tick prompt-token telemetry: record prompt, cache-read, and pre-first-edit tokens on tick_end (planned 2026-10-06, done 2026-10-06; commit 1c404bf4)
- GUI Pending view: show each loop's unlanded change in the dashboard (planned 2026-10-06, done 2026-10-06; commit 5ecdaaa6)
- Model tiers, part 8/8: writers emit the new form, and the docs describe tiers (planned 2026-10-05, done 2026-10-06; commit a061ef22)
- Model tiers, part 7c/8: the doctor checks every declared tier model (planned 2026-10-05, done 2026-10-06; commit a6dbdfc7)
- Model tiers, part 7b/8: the `budget_fallback` badge lists the tiers (planned 2026-10-05, done 2026-10-06; commit 780566bb)
- Model tiers, part 7a/8: role rows show each loop's seam tier and resolved selector (planned 2026-10-05, done 2026-10-06; commit 68d9f02f)
- Model tiers, part 5c/8: budgetGate semantics, the per-role pause set, and handback by resolved pair (planned 2026-10-06, done 2026-10-06; commit c9490bc1)
- Model tiers, part 5b/8: the fallback breaker becomes a map keyed by pair (planned 2026-10-06, done 2026-10-06; commit 251fb9a3)
- Model tiers, part 5a/8: the per-tier budget-fallback resolution engine (planned 2026-10-05, done 2026-10-06; commit d920b64a)
- Model tiers, part 6/8: the fleet-wide backend hold keys storms by provider (planned 2026-10-05, done 2026-10-06; commit 286a5195)
- Model tiers, part 4/8: the conflict resolver runs on the strong tier (planned 2026-10-05, done 2026-10-06; commit 60bcc363)
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
