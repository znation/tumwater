/** Parsing one line of pi's JSONL event stream — pure string functions with no subprocess or
 * file I/O. Split out of pi.ts — which keeps the child-process integration (runPi, piArgs,
 * PiStreamParser) — because these are shared by every observer that folds raw pi log lines into
 * per-type state (progress.ts's live tail, transcript.ts's renderer), and those display modules
 * should not import from the subprocess layer for a pure parse: the same separation
 * reply-contract.ts gives the sentinel/verdict text. */

/** The `type` value of one pi event line in pi's compact type-first serialization
 * (`{"type":"<event>",…}` — 100% of lines in observed logs), or null when the line does not
 * match that exact prefix (a future pi serialization, torn or foreign JSON). Callers use it as
 * a pre-filter before JSON.parse: a non-null type they do not act on is verifiably irrelevant
 * and skips the parse; null falls through to a full parse — exactly the behavior without the
 * fast path — so it can only ever skip lines whose type is verifiably uninteresting, never
 * lose output. */
export function piEventType(line: string): string | null {
  if (!line.startsWith('{"type":"')) return null;
  const end = line.indexOf('"', 9);
  return end > 9 ? line.slice(9, end) : null;
}

/** Parse one raw pi log line into an event object, or null when there is nothing for a consumer
 * acting on `types`: blank lines, torn/non-JSON lines, and lines whose compact type-first prefix
 * verifiably names a type outside `types` (the piEventType fast path) all yield null. A line
 * whose prefix does not match pi's compact shape still gets a full parse — the pre-filter can only
 * ever skip lines whose type is verifiably uninteresting, never lose output. Shared by every
 * observer that folds raw pi log lines into per-type state (progress.ts's live tail,
 * transcript.ts's renderer), so the trim → pre-filter → parse preamble and its skip-without-
 * failing policy live in one place instead of drifting between consumers of the identical log —
 * worth it because pi logs are ~97% streaming delta lines (message_update) that every consumer
 * discards after parsing them. */
export function parsePiEventLine<T>(line: string, types: ReadonlySet<string>): T | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // Cheap pre-filter before JSON.parse (see piEventType): skip the parse when the line's type is
  // verifiably not one this consumer acts on.
  const type = piEventType(trimmed);
  if (type !== null && !types.has(type)) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null; // Torn or non-JSON line — skip without failing.
  }
}
