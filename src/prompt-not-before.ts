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
 * `YYYY-MM-DDTHH:MM:SS.sssZ`. Only a stamp in this shape counts as plumbing; anything else
 * after the prefix is the prompt's own content (e.g. a queued prompt that begins with a
 * marker-like line asking a loop to fix the marker itself), not a deferral. */
const NOT_BEFORE_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A queued prompt's not-before time (epoch ms) parsed from the marker line at the top of its
 * queue-file text, or null when the prompt carries no marker or a malformed one. Only the
 * writer's exact ISO-UTC stamp shape (NOT_BEFORE_STAMP) reads as a marker, so operator
 * content that merely starts with the prefix stays content; an ISO stamp that fails to
 * parse reads as null (deliverable) so a hand-edited file can never strand a prompt
 * forever. A past or present stamp reads as itself — deliverable now, like null. */
export function notBeforeMs(text: string): number | null {
  if (!text.startsWith(NOT_BEFORE_PREFIX)) return null;
  const firstLine = text.slice(NOT_BEFORE_PREFIX.length).split("\n", 1)[0] ?? "";
  if (!NOT_BEFORE_STAMP.test(firstLine)) return null;
  const stamp = Date.parse(firstLine);
  return Number.isNaN(stamp) ? null : stamp;
}

/** The prompt text without its not-before marker line — the operator-facing shape (the CLI
 * list's text, the previews): the marker is plumbing, not content, so no display surface
 * shows it. A text without a marker passes through unchanged. */
export function stripNotBeforeMarker(text: string): string {
  // Only a writer-shaped marker (notBeforeMs's exact stamp) is plumbing: a prompt whose own
  // first line starts with the prefix passes through whole.
  if (notBeforeMs(text) === null) return text;
  return text.replace(/^tumwater:not-before .+\n\n/, "");
}

/** Deliverable now: no marker, or its time has arrived. The one predicate every
 * deliverability filter (dequeue, peek, the counts) shares. */
export function deliverableNow(text: string, now: number): boolean {
  const at = notBeforeMs(text);
  return at === null || at <= now;
}