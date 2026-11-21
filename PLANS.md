# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

### An accepted checkpoint compacts the session by writing the compaction entry directly at the next turn boundary: the checkpoint tool's `ctx.compact()` is replaced by a `turn_end` boundary draft that appends the compaction entry itself and stops the aborted-turn kill (planned 2026-11-21 by the plan role, closing the Needs-review note on the BUGS.md entry "An accepted checkpoint still leaves the session uncompacted…")

**Planning decision (2026-11-21).** The bug's fork — keep the run alive until `compaction_end`, or write the compaction entry directly — is resolved to the direct write, because the keep-alive fork is not buildable. Read of pi 1.5.2's installed `dist/core/agent-session.js`: `compact()` awaits `abort()`, `abort()` (src/dist/core/agent-session.js:2073) awaits `waitForIdle()`, `isIdle` is `!_isAgentRunActive && !isCompacting`, and `_isAgentRunActive` is cleared in `_emitAgentSettled` only after the `agent_settled` extension handlers return — so an extension that keeps the run alive from `agent_settled` deadlocks against the very settle `compact()`'s abort waits on. Print mode (`dist/modes/print-mode.js`) exits after the last `session.prompt()` resolves, i.e. once the aborted turn settles, so the background `compact()` never emits `compaction_end` before the process dies — matching the observed start-without-end log. The keep-alive path is unimplementable offline and wrong on real pi. The direct write — pi's own boundary-draft mechanism — is first-class: the `turn_end` `emitBoundary` contract (dist/core/extensions/runner.js:767) lets a handler return `{ entries: [{ type: "compaction", summary, firstKeptEntryId, tokensBefore, details }] }`, `_commitBoundaryDrafts` (`agent-session.js:690`) appends it via `sessionManager.appendCompaction` and emits `entry_appended`, and the projection (`session-manager.js` `buildContextEntries`) retains the kept range from `firstKeptEntryId` — the same values the `session_before_compact` handler already computes today. The `checkpoint` tool then never calls `compact()` at all, so no turn is aborted and the run survives the `checkpoint` call (this directly fixes "the run loses its turn" — the tool's accept arm today calls `ctx?.compact?.()` which aborts the turn still running it).

**Approach.**
- In `src/pi-extension/checkpoint.ts`: drop `ctx?.compact?.()` from the tool's accept arm (the tool result keeps the echoed prose and replaces the now-false "the context is being compacted" suffix with the honest wording, e.g. "the context will be compacted at the next turn boundary"). Add a `turn_end` boundary handler, sharing the module's existing `state`: when `state.requested && state.fields`, build the summary from the run's own `done/state/next` prose (`state.fields`) plus the file ops read from the projected `event.context` entries and the capped git reads through `pi.exec`, reusing `buildCheckpointSummary`; compute `firstKeptEntryId` from the projected context; and return `{ entries: [{ type: "compaction", summary, firstKeptEntryId, details }] }`, then clear `state.requested`/`state.fields`. When `state` is not as requested the handler returns `undefined`, leaving pi's own threshold/overflow compactions to pi. Retain the `session_before_compact` handler as the guard that still returns `undefined` for pi's own compactions (the checkpoint path no longer reaches it, since the tool never calls `compact()`).
- `firstKeptEntryId` for a checkpoint must keep the recent ~20k tokens (the same `keepRecentTokens` pi's `findProjectedCutPoint` targets): the handler walks `event.context`'s projected entries backward, accumulating `estimateTokens`-style char/4 counts until ~20k, and returns the cut entry's id. Since the turn-end projection is what the next prompt will send, the boundary rewrite is self-consistent. (pi's `_applyBoundaryDrafts`, `agent-session.js:647`, fills `tokensBefore` and `usage` itself from the draft's projection, so the handler returns only `summary`, `firstKeptEntryId`, `details`.)
- In `src/pi/pi-stream.ts`, `applyCompaction` gains the boundary-draft write as compaction evidence: an `entry_appended` event whose `entry` is a `{ type: "compaction" }` entry sets `compacted = true`, the same completion bar a `compaction_end` with a result meets — pi's `_commitBoundaryDrafts` (`agent-session.js:690`) appends the checkpoint's compaction entry and emits `entry_appended`, so the harness's session-was-compacted flag must hear it (INV-DD1: `compacted` records a compaction the session holds).
- The file ops for the summary come from the projected `event.context` entries (the `fileOps` the `session_before_compact` preparation carries are pi's for the not-yet-summarized range; at turn end the checkpoint's range is the whole preceding projection).
- Keep the tool's acceptance decision, the floor, the turn-gap, and the `session_before_compact` handler exactly as they are; only the compaction mechanism changes. `bundledExtensionPaths` (src/pi/pi-args.ts) already loads `checkpoint.js` for author runs and drops it for gate runs — unchanged.

**Files touched.** `src/pi-extension/checkpoint.ts`; `src/pi/pi-stream.ts`; `test/checkpoint.test.ts`; `test/pi-parser.test.ts`.

**Acceptance criteria.**
- In test/pi-parser.test.ts: feeding `{"type":"entry_appended","entry":{"type":"compaction",summary,"details":…}}` sets `compacted`; feeding it for a non-compaction entry (e.g. a `context_edit` from context-shake) does not; a lone `compaction_start` still does not.
- An adapter test drives the `turn_end` handler through the existing `fakePi()`: after a ready `checkpoint` call, invoking `handlers.turn_end({ context: { contextEntries: […] } })` returns `{ entries: [{ type: "compaction", summary, firstKeptEntryId, details }] }` with a summary containing the model's `done/state/next` prose and the git block, and clears the requested state so a second `turn_end` returns `undefined`.
- The tool's accept path never calls a `compact` function: a fake `ctx` whose `compact` throws is still accepted and records the checkpoint, and the result wording says the compaction is queued for the next turn boundary rather than claiming it is already compacting.
- test/checkpoint.test.ts's existing adapter tests still pass for the retained `session_before_compact` guard (it returns `undefined` for an unrequested compaction).
- The extension itself never ends the run on an accepted checkpoint: a fake-pi script whose prompt flow is `checkpoint` tool result then a further assistant message logs both, because the tool no longer calls `ctx.compact()` (which is what aborts the turn on real pi) and the `turn_end` boundary's `continue` is not touched — the only turn-end exit pi sees is whatever the run would have chosen anyway.
- docs/invariants.md INV-DD1 (compaction evidence) gains the boundary-draft arm: `entry_appended` bearing a `compaction` entry is compacting evidence the same way a completed `compaction_end` is, and the Binds/Pinned-by lists name `applyCompaction`'s new arm and the pi-parser test.

### The two live over-cap buffers drain through one pinned trim, so a growing transcript or follow session cannot keep memory unbounded or drop the newest entry (planned 2026-11-21 by the plan role)

A follow-mode transcript and the `logs --follow` event buffer both cap themselves by calling
`trimToLast` after each append (src/ui/transcript.ts `feedEntries` with `MAX_ENTRIES` = 200;
src/history/history.ts with `HISTORY_FOLLOW_BUFFER_EVENTS` = 2000). Nothing pins the trim itself:
`trimToLast` (src/collections.ts) has no test — grep `trimToLast` under test/ returns 0 hits — and
no test shows a buffer that overflows by more than one entry keeping the newest entries and
dropping only the oldest, so a refactor back to a one-element shift, or a trim that runs before
rather than after a batch append, would pass the suite while silently growing an unbounded buffer
or cutting the entry the caller just appended.

**Approach.** Pin the contract at the helper and at both live sites, in one change. In
test/collections.test.ts, add `trimToLast` to the existing `../src/collections.js` import and pin
the helper directly: an array longer than `max` keeps exactly its last `max` elements in order; the
excess is dropped from the front in one step, so an array that overflows by many at once (e.g. 5
elements at `max` 2) keeps the newest 2; an array at or under `max` is left identical, element for
element; `max` 0 empties it; the mutation is visible through the caller's own reference (same array,
not a replacement). In test/transcript.test.ts, extend the retention test that already feeds 250
runs past the 200-entry cap to assert the exact boundary rather than only that an old entry is gone:
the rendered tail for a request of 250 is exactly 200 entries, its newest entry is the last one fed,
and its oldest is the 51st — never 201 entries and never the newest one missing. In
test/history-follow.test.ts, keep the scripted event count above `HISTORY_FOLLOW_BUFFER_EVENTS` and
assert the follow session still reports the run row for the run that ended last, which fails if the
drain drops from the back or stops running. No behaviour change is expected; if a site turns out to
mis-drain, fix that site in the same commit and say so in the commit message.

**Files touched.** test/collections.test.ts, test/transcript.test.ts, test/history-follow.test.ts;
src/ui/transcript.ts and src/history/history.ts only if a pinned behaviour turns out wrong.

**Acceptance criteria.**
- test/collections.test.ts: feeding `trimToLast` 5 elements with `max` 2 leaves the array holding exactly the last 2, in order, through the caller's original reference; an array at or under `max` is unchanged element for element; `max` 0 leaves it empty.
- test/transcript.test.ts: after more than `MAX_ENTRIES` entries are fed for one role, a tail request larger than the cap renders exactly `MAX_ENTRIES` entries — the newest fed entry is present, and the entry count is never one over the cap.
- test/history-follow.test.ts: a follow session whose scripted events exceed `HISTORY_FOLLOW_BUFFER_EVENTS` still prints the row for the most recently ended run.
- The suite passes with no change under src/ unless a real mis-drain is found; a reviewer can see from the diff which case each new assertion pins.

## Done
