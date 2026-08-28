/** Shared text-shaping helpers for the observability layer's display labels (live progress,
 * transcripts, tool-call descriptions) and its number formats: whitespace collapsing,
 * ellipsis truncation, and compact token counts. Presentation only: depends on nothing, so
 * any display surface can import it without reaching into another module's internals — and
 * the collapse/truncation/compaction semantics live in exactly one place instead of drifting
 * per consumer. */

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

/** Compact token count for display: one-decimal `k` at ≥10,000 (`12.3k`), bare integer
 * below. The single home of this format — the status table's gen/peak-ctx columns and the
 * commit trailer's ctx field both render through it, so they cannot drift. (The GUI renders
 * the same rule from its own JS copy in gui-page.ts: a separate runtime that cannot import
 * TypeScript.) */
export function compactTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
