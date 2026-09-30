import path from "node:path";
import { isJsonObject } from "./json-object.js";

/** Shared text-shaping helpers for human-facing one-line text — the observability layer's
 * display labels (live progress, transcripts, tool-call descriptions), tick commit subjects and
 * body fields, and build-check reason lines — plus number formats: whitespace collapsing,
 * ellipsis truncation, compact token counts, abbreviated commit hashes, and plain-decimal
 * integer parsing. (Local date/time formatting and calendar-day arithmetic live in
 * datetime.ts.) Presentation only:
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
 * high surrogate in the kept part, which terminals render as garbage (a U+FFFD box). truncate
 * backs off one unit before such a cut so no truncated line ever carries a lone surrogate;
 * clipToWidth instead cuts on code-point boundaries, where a split cannot occur. */
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

/** One bounded one-line detail from a blob: collapseWhitespace then truncate — the shape
 * every summary, error, and work-item line takes before display (a multi-line pi message or
 * command output becomes a single line that fits its budget). Consumers call this one helper
 * instead of composing the two, so the collapse-then-bound order cannot drift apart or be
 * reversed (truncating first could cut a word mid-run and leave the collapse room to spare). */
export function squash(s: string, max: number): string {
  return truncate(collapseWhitespace(s), max);
}

/** East Asian Wide/Fullwidth and common emoji code-point ranges that render two terminal
 * columns wide — an approximate wcwidth table covering the CJK, Hangul, fullwidth, and emoji
 * text this harness's labels and lines realistically carry. Combining marks and variation
 * selectors count as one column, which only overestimates width, so clippers driven by these
 * numbers cut earlier than strictly needed and can never overflow the budget. */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

/** The terminal display width of one code point: 2 in the wide ranges above, else 1. */
function codePointWidth(cp: number): number {
  for (const [lo, hi] of WIDE_RANGES) if (cp >= lo && cp <= hi) return 2;
  return 1;
}

/** The terminal display width of `s` in columns: each code point counts 1, except the wide
 * ranges above, which count 2. Iterating by code point (not code units) makes an astral
 * character such as emoji one unit of width 2 — not two half-width halves — so a surrogate
 * pair can never be measured or cut apart. */
export function displayWidth(s: string): number {
  let total = 0;
  for (const ch of s) total += codePointWidth(ch.codePointAt(0)!);
  return total;
}

/** Pad `s` with trailing spaces until it occupies exactly `width` terminal display columns —
 * the display-width sibling of String#padEnd, which counts UTF-16 code units and under-pads
 * any cell holding wide characters (CJK, emoji), letting its column drift right. Text already
 * past `width` is returned unchanged; callers clip first when a cell must not exceed the
 * column. Shared by the aligned tables (status-render.ts, history.ts). */
export function padToWidth(text: string, width: number): string {
  const pad = width - displayWidth(text);
  return pad > 0 ? text + " ".repeat(pad) : text;
}

/** Clip `s` to `width` terminal display columns with a trailing ellipsis when over — the
 * column-budget sibling of truncate, which caps by character budget. Widths are measured by
 * displayWidth, so East Asian wide characters and emoji count their real two columns and a
 * clipped line cannot overflow a terminal of that many columns. The invariants, held at every
 * width including the degenerate ones: the result's display width never exceeds `width`; text
 * that fits is returned unchanged; and a cut never splits a surrogate pair, because cuts land
 * on code-point boundaries and a wide character that cannot fit is dropped whole. Widths ≤ 1
 * leave no room for an ellipsis, so they clip bare — a leading run of single-column characters
 * up to the budget, possibly nothing when the text opens with a wide character. A non-positive
 * width fits nothing and yields the empty string. Shared by the status table (status-render.ts)
 * and the TUI's line rendering (tui.ts). */
export function clipToWidth(text: string, width: number): string {
  if (width <= 0) return ""; // A non-positive width fits nothing.
  if (displayWidth(text) <= width) return text;
  const clip = (budget: number): string => {
    let total = 0;
    let end = 0;
    for (const ch of text) {
      const w = codePointWidth(ch.codePointAt(0)!);
      if (total + w > budget) break; // Cut on a code-point boundary — never mid-surrogate-pair.
      total += w;
      end += ch.length;
    }
    return text.slice(0, end);
  };
  if (width <= 1) return clip(width); // No room for an ellipsis at degenerate widths.
  return `${clip(width - 1)}…`; // The ellipsis itself takes one column.
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

/** A count and its noun as one phrase (`plural(3, "tick")` → `3 ticks`) — the single home of
 * the singular/plural selection the CLI's once summary (cli-run.ts), the day window's day label
 * (datetime.ts), the failure digest's loss-cause lines (failure-report.ts), and the fleet
 * alerts' banner titles (ui/fleet-alerts.ts, whose local copy this replaces) all rendered
 * inline before. `many` accepts a whole replacement form (`plural(n, "loop is", "loops are")`)
 * so verb-agreement titles share the helper; the plural-by-`s` default covers regular nouns.
 * (The GUI keeps its own JS copy in gui-client.ts: a separate runtime that cannot import
 * TypeScript.) */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
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

/** The `$<spent> of $<cap>` fragment every budget-transition event renders — the one home of
 * that phrasing, shared by the event feed (event-format.ts) and the failure digest's Fleet
 * state changes lines (failure-report.ts), so a budget transition reads the same on both
 * surfaces. Both fields arrive loosely typed on HarnessEvent, so each is coerced through the
 * cents-pinned money format (usd) here. */
export function budgetPhrase(spentUsd: unknown, capUsd: unknown): string {
  return `${usd(Number(spentUsd ?? 0))} of ${usd(Number(capUsd ?? 0))}`;
}

/** A short duration as `Ns` under two minutes, else whole `Nm` — the one home of that cutoff
 * and rounding, shared by holdPhrase ("for 60s") and the event feed's countdowns
 * ("(in 90s)"), so the threshold or the units cannot drift between the two renderings. */
export function shortSpanPhrase(ms: number): string {
  return ms < 120_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
}

/** The `for <duration>[ (relapse N)]` fragment the rate_limit_hold event renders — the one
 * home of that phrasing, shared by the event feed (event-format.ts) and the failure digest's
 * Fleet state changes lines (failure-data.ts), like budgetPhrase. The duration is shortSpanPhrase
 * (seconds under two minutes, so the one-minute base hold reads `60s`); the relapse count is
 * named only when the storm resumed right after an earlier hold, the one fact that says the
 * hold doubled. Both fields arrive loosely typed on HarnessEvent, so each is coerced here. */
export function holdPhrase(holdMs: unknown, escalation: unknown): string {
  const ms = Math.max(0, Number(holdMs ?? 0)) || 0;
  const span = shortSpanPhrase(ms);
  const relapse = Number(escalation ?? 0);
  return `for ${span}${relapse > 0 ? ` (relapse ${relapse})` : ""}`;
}

/** The human phrase for a fleet hold's backend-failure kind — the one home of that phrasing,
 * shared by the event feed (event-format.ts) and the failure digest's Fleet state changes
 * lines (failure-state-change.ts), like holdPhrase above. A "rate-limit" hold (or a
 * hold with no readable kind — a torn line) never renders through this: those keep the 429
 * wording, which is the shape every historical event already has. */
export function backendKindPhrase(kind: unknown): string {
  switch (kind) {
    case "connection":
      return "connection error";
    case "timeout":
      return "request timed out";
    case "server":
      return "server error";
    case "model-load":
      return "model load failure";
    default:
      return "backend failure";
  }
}

/** One-line description of a tool call from its name and args — shared by live progress data
 * collection (LiveProgress.lastTool), transcript rendering, and the harness's stalled-tool-call
 * warning (src/pi.ts names the hung command through it). Path-like keys reduce to the file
 * name; the other candidate keys are shown verbatim. */
export function describeToolCall(toolName: string, args: unknown): string {
  let detail = "";
  if (isJsonObject(args)) {
    const candidate = args.path ?? args.file_path ?? args.command ?? args.cmd ?? args.pattern ?? args.url;
    if (typeof candidate === "string") {
      detail =
        candidate === args.path || candidate === args.file_path ? path.basename(candidate) : candidate;
    }
  }
  detail = squash(detail, 32);
  // An empty name (pi omits toolName on some start events) yields the bare detail — no
  // leading space in front of it.
  return detail ? (toolName ? `${toolName} ${detail}` : detail) : toolName;
}
