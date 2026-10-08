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

/** Read an untrusted JSON field that should be a string list, returning its string entries
 * when it is an array and [] otherwise — the one home of the "an event/record field is the
 * list or it is nothing" read every formatter applies (event-format.ts's review_rejected
 * reasons, dep_install packages, config_changed keys; src/failure/failure-state-change.ts's
 * config_changed keys; time-spend.ts's review-rejection reasons; fleet-state.ts's paused-roles
 * list). A torn or hand-edited line
 * never throws and never renders a placeholder: the field reads as absent, and the caller's
 * empty-list branch fires. Foreign entries inside an array are dropped for the same reason —
 * letting them through made `join` render "[object Object]" and handed
 * truncateExample's `.trim()` an object (a TypeError) — so every returned element is a
 * string. */
export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Read an untrusted JSON field that should be a number, returning `fallback` when it is
 * absent, not a number, or not finite (NaN/±Infinity poison arithmetic and comparisons: a
 * NaN costUsd makes every budget-cap comparison false, so the cap never trips) — the one
 * home of the "the field is the number or it is nothing" read. The exact call sites:
 * event-read.ts's eventUsage (tokens, costUsd → 0), phrases.ts's budgetPhrase (spentUsd,
 * capUsd → 0), redeploy.ts's autoRestartRecord (lastAt → null), build/build-info.ts's
 * readBuildInfo (builtAt → 0), budget/budget.ts's spendNumber (dayCostUsd/usd → 0), and
 * test/test-runner.ts's orderByDuration cost (→ Infinity, the "no recorded duration" marker).
 * Fields that carry an extra constraint beyond finiteness keep their own check beside the
 * call (pi/pi-stream.ts's usageNumber, failure/time-spend.ts's tickDurationMs and
 * budget/budget.ts's spendNumber additionally require >= 0). */
export function finiteNumber<T>(value: unknown, fallback: T): number | T {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
