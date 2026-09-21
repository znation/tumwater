import path from "node:path";

/** Shared text-shaping helpers for human-facing one-line text — the observability layer's
 * display labels (live progress, transcripts, tool-call descriptions), tick commit subjects and
 * body fields, and build-check reason lines — plus number and time formats: whitespace
 * collapsing, ellipsis truncation, compact token counts, abbreviated commit hashes, plain-
 * decimal integer parsing, and zero-padded local date/time parts. Presentation only:
 * depends on node built-ins alone, so any layer (harness or observer) can import it without
 * reaching into another module's internals — and the collapse/truncation/compaction/
 * abbreviation semantics live in exactly one place instead of drifting per consumer. */

/** Collapse every run of whitespace to a single space and trim both ends — the shape every
 * one-line label takes before display (multi-line pi text, command strings, error messages). */
export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The human-facing message of whatever was thrown: its `.message` when it is an Error,
 * `String(err)` otherwise (a thrown string or other value). Every catch site that surfaces a
 * failure as text renders unknown throws through this one coercion instead of repeating the
 * instanceof check per consumer. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when `code` is a UTF-16 high (leading) surrogate — the first code unit of an astral
 * character's two-unit encoding (emoji and other non-BMP characters). */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** True when `code` is a UTF-16 low (trailing) surrogate — the second code unit of an astral
 * character's two-unit encoding. */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** True when cutting `s` at code-unit index `i` would split a surrogate pair — leaving a lone
 * high surrogate in the kept part, which terminals render as garbage (a U+FFFD box). The display
 * clippers (truncate and clipToWidth, both here) back off one unit before such a cut so no
 * clipped line ever carries a lone surrogate. */
export function cutSplitsSurrogatePair(s: string, i: number): boolean {
  return i > 0 && i < s.length && isHighSurrogate(s.charCodeAt(i - 1)) && isLowSurrogate(s.charCodeAt(i));
}

/** Shorten `s` to at most `max` characters: unchanged when it fits, otherwise cut to
 * `max - 1`, drop any trailing space the cut may have left behind, and append an ellipsis.
 * The result is never longer than `max`. A cut that would split a surrogate pair (an astral
 * character such as emoji) backs off one unit instead — dropping the whole character rather
 * than emitting a lone surrogate, which terminals render as garbage. A non-positive `max`
 * fits nothing — not even the ellipsis — and yields the empty string, so the length
 * invariant holds at degenerate budgets too. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return ""; // A non-positive max fits nothing; without this, slice(0, -1) would keep almost all of s.
  if (s.length <= max) return s;
  let cut = max - 1;
  if (cutSplitsSurrogatePair(s, cut)) cut -= 1; // Never emit a lone high surrogate.
  return `${s.slice(0, cut).trimEnd()}…`;
}

/** Clip `s` to `width` display columns with a trailing ellipsis when over — the column-budget
 * sibling of truncate, which caps by character budget. The result never exceeds `width`
 * characters (even at width ≤ 1), so a clipped line cannot wrap in a terminal of that many
 * columns. A cut that would split a surrogate pair backs off one unit, so no line ever carries
 * a lone surrogate (terminals render it as garbage). A negative width fits nothing and yields
 * the empty string, keeping the invariant at degenerate budgets. Shared by the status table
 * (status-render.ts) and the TUI's line rendering (tui.ts). */
export function clipToWidth(text: string, width: number): string {
  if (width < 0) return ""; // A negative width fits nothing; without this, slice(0, -1) would keep almost all of text.
  if (text.length <= width) return text;
  const bare = width <= 1; // No room for an ellipsis at degenerate widths.
  let cut = bare ? width : width - 1;
  if (cutSplitsSurrogatePair(text, cut)) cut -= 1; // Never emit a lone high surrogate.
  return bare ? text.slice(0, cut) : `${text.slice(0, cut)}…`;
}

/** The one definition of a valid plain-decimal integer across every input surface (CLI flags
 * and the GUI's query params): a run of digits `Number()` represents exactly, or null. Number()
 * would silently coerce hex ("0x10" → 16), scientific ("1e3" → 1000), and signed or
 * whitespace-padded forms, none of which a user typing a count or position meant; a digit run
 * too long to represent exactly (it overflows to Infinity, or lands above
 * Number.MAX_SAFE_INTEGER) is null too — there is no honest count to return, and passing the
 * overflow on let `logs -n <40 digits>` read the whole log. The two public parsers below add
 * their own sign/zero policy; each caller keeps its own missing-value check and failure mode
 * (fail vs HTTP 400), and bounded variants like --port add their upper limit. */
function parseDecimalInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null; // Decimal digits only — no hex, exponent, sign, or padding.
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** Parse `raw` as a positive integer — the one definition of what counts as a valid count or
 * position across every input surface. Null when it isn't one (plain-decimal rule above). */
export function parsePositiveInt(raw: string): number | null {
  const n = parseDecimalInt(raw);
  return n !== null && n >= 1 ? n : null;
}

/** Parse `raw` as a non-negative integer — zero-based positions (like /api/backlog's index,
 * where the first entry is 0), unlike parsePositiveInt's counts and 1-based positions, for
 * which 0 is invalid. The plain-decimal rule is the same as parsePositiveInt's. */
export function parseNonNegativeInt(raw: string): number | null {
  return parseDecimalInt(raw);
}

/** Compact token count for display: bare integer below 10,000, one-decimal `k` to
 * 999,999 (`12.3k`), one-decimal `M` at ≥1,000,000 (`13.8M`, uppercase `M`). The single home
 * of this format — the status table's gen/peak-ctx columns, the ctx chip, the commit trailer's
 * ctx field, and the usage report's totals/table cells all render through it, so they cannot
 * drift. (The GUI renders the same rule from its own JS copy in gui-client.ts: a separate
 * runtime that cannot import TypeScript.) */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
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

/** A USD amount with its dollar sign and exactly two decimals ($12.34) — the single home of
 * the cents-pinned money format shared by the event feed's budget/usage lines (event-format.ts)
 * the status table's cost/today cells plus totals row (status-render.ts), and the usage
 * report's totals line plus per-day cost column (report.ts), so the decimal width cannot
 * drift per consumer. The cap variant that drops whole-dollar `.00` is a different
 * format (`usdCap` below); the GUI's row cells still format money from their own inline JS (a
 * separate runtime that cannot import TypeScript), while header badges like `budgetBadge`
 * arrive preformatted. */
export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** A USD cap for display: whole dollars stay bare ($50), fractional ones keep their cents
 * ($12.34) — the budget badge reads `· budget: $12.34/$50 today`, and the TUI's cap-edit
 * confirmation reads `budget set to $25`. The single home of the drop-`.00` rule, shared by
 * status-model's `budgetBadge` and the TUI's budget-edit flash so the two cannot drift. */
export function usdCap(n: number): string {
  return `$${n.toFixed(2).replace(/\.00$/, "")}`;
}

/** Zero-pad an integer to two digits — the clock and calendar components every local-time
 * display in the harness renders through (transcript run separators, the status table's last-
 * tick cell, the daily-budget day stamp), so zero-padding cannot drift per consumer. */
export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Calendar date as `YYYY-MM-DD` in local time — shared by the transcript run separators,
 * the daily-budget day stamp (todayStamp), and the usage report's per-day buckets, which must
 * all agree on what counts as one day. */
export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Wall-clock time as zero-padded `HH:MM:SS` in local time — shared by the transcript run
 * separators and the status table's last-tick cell. */
export function formatTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Local midnight of the day `offsetFromToday` days before `now` (0 = today): the day-count
 * arithmetic the usage report and the failure digest share, so their windows select the same
 * calendar days. The Date constructor handles month/year edges; `now` is passed explicitly so
 * every day in one window derives from the same instant. */
export function dayAt(offsetFromToday: number, now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetFromToday);
}

/** `N days`, singular at 1 — the window label both report headers render, so a one-day window
 * reads the same on either surface. */
export function dayLabel(days: number): string {
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** The report header both renderers print: the window's day-key bounds, its length in days
 * (singular at 1), and the event log it was read from. The failure digest appends its own tick
 * count. */
export function reportWindow(from: string, to: string, days: number): string {
  return `Window: ${from} → ${to} (${dayLabel(days)}) · source: events.jsonl (rotated at 16 MB)`;
}

/** One-line description of a tool call from its name and args — shared by live progress data
 * collection (LiveProgress.lastTool), transcript rendering, and the harness's stalled-tool-call
 * warning (src/pi.ts names the hung command through it). Path-like keys reduce to the file
 * name; the other candidate keys are shown verbatim. */
export function describeToolCall(toolName: string, args: unknown): string {
  let detail = "";
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    const candidate = a.path ?? a.file_path ?? a.command ?? a.cmd ?? a.pattern ?? a.url;
    if (typeof candidate === "string") {
      detail = candidate === a.path || candidate === a.file_path ? path.basename(candidate) : candidate;
    }
  }
  detail = truncate(collapseWhitespace(detail), 32);
  // An empty name (pi omits toolName on some start events) yields the bare detail — no
  // leading space in front of it.
  return detail ? (toolName ? `${toolName} ${detail}` : detail) : toolName;
}
