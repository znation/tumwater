/** Shared text-shaping helpers for the observability layer's one-line display labels (live
 * progress, transcripts, tool-call descriptions): whitespace collapsing and ellipsis
 * truncation. Presentation only: depends on nothing, so any display surface can import it
 * without reaching into another module's internals — and the collapse/truncation semantics
 * live in exactly one place instead of drifting per consumer. */

/** Collapse every run of whitespace to a single space and trim both ends — the shape every
 * one-line label takes before display (multi-line pi text, command strings, error messages). */
export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Shorten `s` to at most `max` characters: unchanged when it fits, otherwise cut to
 * `max - 1`, drop any trailing space the cut may have left behind, and append an ellipsis.
 * The result is never longer than `max`. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}
