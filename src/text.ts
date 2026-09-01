/** Shared text-shaping helpers for human-facing one-line text — the observability layer's
 * display labels (live progress, transcripts, tool-call descriptions), tick commit subjects and
 * body fields, and build-check reason lines — plus number and time formats: whitespace
 * collapsing, ellipsis truncation, compact token counts, abbreviated commit hashes, and
 * zero-padded local date/time parts. Presentation only:
 * depends on nothing, so any surface can import it without reaching into another module's
 * internals — and the collapse/truncation/compaction/abbreviation semantics live in exactly one
 * place instead of drifting per consumer. */

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

/** The abbreviated form of a commit hash for human-facing text — its first 8 characters.
 * The single home of this format: the event feed's merged/review lines and the review gate's
 * discard warning all render hashes through it, so the abbreviation length cannot drift per
 * consumer. Takes unknown because harness events carry their fields loosely typed (the
 * index signature), coercing exactly as the inline `String(…).slice(0, 8)` did before. */
export function shortSha(sha: unknown): string {
  return String(sha).slice(0, 8);
}

/** Zero-pad an integer to two digits — the clock and calendar components every local-time
 * display in the harness renders through (transcript run separators, the status table's last-
 * tick cell, the daily-budget day stamp), so zero-padding cannot drift per consumer. */
export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Calendar date as `YYYY-MM-DD` in local time — shared by the transcript run separators and
 * the daily-budget day stamp (todayStamp), which must agree on what counts as one day. */
export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Wall-clock time as zero-padded `HH:MM:SS` in local time — shared by the transcript run
 * separators and the status table's last-tick cell. */
export function formatTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
