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
