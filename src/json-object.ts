/** True when `value` is a plain JSON object — not null, not an array, not a scalar. The one
 * definition of "a JSON object at this position" for every consumer that parses untrusted
 * JSON (the state/marker/info files, the harness event log, pi's stdout log lines, an HTTP
 * request body, tumwater.json's sections, a model's cost map, the qa coverage ledger), so the
 * three-part check cannot be spelled out slightly differently — or forgotten — at one site
 * while the others reject the same torn/foreign value. Narrows to an indexable object, which
 * also removes the `as Record<string, unknown>` cast each caller used to add after the check.
 *
 * JSON.parse("null") succeeds and yields null, and an array is an object in JS: both pass a
 * bare `typeof x === "object"` and then throw or misread when indexed, so the null and array
 * clauses are part of the definition, not extras. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read an untrusted JSON field that should be a string list, returning the array when it
 * is one and [] otherwise — the one home of the "an event/record field is the list or it is
 * nothing" read every formatter applies (event-format.ts's review_rejected reasons,
 * dep_install packages, config_changed keys; failure-state-change.ts's config_changed keys;
 * time-spend.ts's review-rejection reasons). A torn or hand-edited line never throws and
 * never renders a placeholder: the field reads as absent, and the caller's empty-list branch
 * fires. The cast is unchecked (the log's writers send strings), matching what each call
 * site did inline; join/map treat non-string entries exactly as the old casts did. */
export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

/** Parse `text` as JSON and require the result to be a plain object, returning null when
 * either half fails — the one home of the "read one JSON value or read it as no data" policy
 * every line-oriented parser here applies (parseEventLine on the harness event log,
 * parsePiEventLine on pi's log lines, PiStreamParser.feedLine on pi's stdout). A torn or
 * partial line, a non-JSON fragment, or a valid-JSON scalar/`null`/array is never a thrower
 * and never a truthy stand-in for data: it reads as nothing, exactly as isJsonObject's
 * definition above requires. Callers that need the parse ERROR (not just its absence) keep
 * their own try/catch, like config-write.ts. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
