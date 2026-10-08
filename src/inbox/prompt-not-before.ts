/** The `tumwater:not-before` marker vocabulary for deferred prompts (PLANS.md "tumwater prompt
 * --at <duration>"). A deferred prompt's queue file starts with one marker line
 * `tumwater:not-before <iso-utc>` followed by a blank line, then the prompt text. Everything
 * downstream treats queue-file text opaquely, so the marker rides in the content and no queue
 * format migrates. Composed by notBeforeMarker, parsed by notBeforeMs — the two live together
 * so format and parser cannot drift. inbox.ts (the prompt-queue store) writes the marker into
 * enqueueRolePrompt's single atomic write and filters on deliverableNow; the display surfaces
 * (prompt-commands.ts, tick-prompt.ts) strip it with stripNotBeforeMarker. */

/** The marker line a deferred prompt's queue file starts with. */
const NOT_BEFORE_PREFIX = "tumwater:not-before ";

/** The marker line (plus the blank separator) that defers a queue file to `at` epoch ms.
 * enqueueRolePrompt composes it in the same single atomic write that births the queue file. */
export function notBeforeMarker(at: number): string {
  return `${NOT_BEFORE_PREFIX}${new Date(at).toISOString()}\n\n`;
}

/** The exact stamp shape notBeforeMarker writes — Date.prototype.toISOString()'s
 * `YYYY-MM-DDTHH:MM:SS.sssZ`. Only a marker carrying the writer's full shape — the stamp line
 * plus the blank separator notBeforeMarker appends — counts as plumbing; anything else
 * after the prefix is the prompt's own content (e.g. a queued prompt that begins with a
 * marker-like line asking a loop to fix the marker itself, or a hand-edited file that lost
 * the blank line), not a deferral. The stamp and separator are checked together so this
 * parser and stripNotBeforeMarker — which strips exactly this shape — can never disagree
 * about what is plumbing. */
const NOT_BEFORE_MARKER = /^tumwater:not-before (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\n\n/;

/** A queued prompt's not-before time (epoch ms) parsed from the marker at the top of its
 * queue-file text, or null when the prompt carries no marker or a malformed one. Only the
 * writer's exact marker shape (NOT_BEFORE_MARKER — stamp line plus blank separator) reads as
 * a marker, so operator content that merely starts with the prefix stays content; an ISO
 * stamp that fails to parse reads as null (deliverable) so a hand-edited file can never
 * strand a prompt forever. A past or present stamp reads as itself — deliverable now, like
 * null. */
export function notBeforeMs(text: string): number | null {
  const m = NOT_BEFORE_MARKER.exec(text);
  if (!m) return null;
  const stamp = Date.parse(m[1] ?? "");
  return Number.isNaN(stamp) ? null : stamp;
}

/** The prompt text without its not-before marker — the operator-facing shape (the CLI
 * list's text, the previews): the marker is plumbing, not content, so no display surface
 * shows it. A text without the writer's marker shape passes through unchanged. */
export function stripNotBeforeMarker(text: string): string {
  // Only a writer-shaped marker (the same NOT_BEFORE_MARKER shape notBeforeMs accepts) is
  // plumbing: a prompt whose own first line starts with the prefix passes through whole.
  if (notBeforeMs(text) === null) return text;
  return text.replace(NOT_BEFORE_MARKER, "");
}

/** Deliverable now from an already-parsed not-before time (notBeforeMs): no marker (`null`),
 * or its time has arrived. The one home for the predicate's `at === null || at <= now` body,
 * shared by deliverableNow (which parses the text first) and the two callers that already
 * hold the parsed value — inbox.ts's queuedRolePrompts and status-data.ts's per-role inbox
 * count — instead of re-spelling the comparison. */
export function deliverableAt(at: number | null, now: number): boolean {
  return at === null || at <= now;
}

/** Deliverable now: parse the queue-file text's not-before marker, then apply deliverableAt.
 * The predicate the text-reading deliverability filters (dequeue, peek) share. */
export function deliverableNow(text: string, now: number): boolean {
  return deliverableAt(notBeforeMs(text), now);
}
