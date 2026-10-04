/** Shared text-shaping helpers for human-facing one-line text — the observability layer's
 * display labels (live progress, transcripts), tick commit subjects and body fields, and
 * build-check reason lines: whitespace collapsing, ellipsis truncation, and plain-decimal
 * integer parsing. (Number, money, and hash formats — compactTokens, shortSha, usd, usdCap —
 * live in format.ts; local date/time formatting and calendar-day arithmetic live in
 * datetime.ts; terminal-column geometry — the wcwidth table and the displayWidth/
 * padToWidth/clipToWidth clippers — lives in text-width.ts; the fleet's shared wording
 * fragments — the red-main phrase, the pause-reason suffix, the hold, budget, and backend
 * phrasings, tool-call labels — live in phrases.ts; the did-you-mean suggestion layer —
 * suggestClosest, didYouMean, typoSuffix — lives in suggest.ts.) Presentation only:
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

/** Is `v` a string with non-whitespace content — the "field carries something usable" guard
 * every structural read of an unknown-typed JSON field applies (a blank or whitespace-only
 * string reads as unset, exactly like a wrong type or a missing key). A type predicate, so a
 * true answer also narrows `v` to `string` for the code that consumes it — the one spelling
 * shared by build-check-detect.ts's check-script/command/cwd/gateCommand reads, config
 * validation's thinking-level check, and pi-event-line.ts's tool-result content test, so the
 * blank-means-unset rule cannot drift per call site. */
export function isNonBlankString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
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

/** Text capped for injection into a prompt: past `max` characters it is cut and given a visible
 * `…[<label> truncated at <max> chars]` note naming what was capped and how much survived, so
 * the loss is never silent. The single home of that marker format — the PRINCIPLES.md cap
 * (principles.ts's readPrinciples) and the initial-prompt backstop (readme.ts's extractPrompt) both
 * render through it, so the two defensive caps cannot drift apart in wording. A plain slice at
 * `max` (not truncate's ellipsis-and-trim cut): the marker carries the ellipsis, and the cut
 * boundary must stay a stable, predictable prefix of the original text. */
export function truncateWithNote(text: string, max: number, label: string): string {
  return text.length > max
    ? `${text.slice(0, max)}\n…[${label} truncated at ${max} chars]`
    : text;
}

/** The one definition of a valid plain-decimal integer across every input surface (CLI flags
 * and the GUI's query params): a run of digits `Number()` represents exactly, or null. Number()
 * would silently coerce hex ("0x10" → 16), scientific ("1e3" → 1000), and signed,
 * whitespace-padded, or leading-zero-padded forms, none of which a user typing a count or
 * position meant; a digit run
 * too long to represent exactly (it overflows to Infinity, or lands above
 * Number.MAX_SAFE_INTEGER) is null too — there is no honest count to return, and passing the
 * overflow on let `logs -n <40 digits>` read the whole log. The two public parsers below add
 * their own sign/zero policy; each caller keeps its own missing-value check and failure mode
 * (fail vs HTTP 400), and bounded variants like --port add their upper limit. */
function parseDecimalInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null; // Decimal digits only — no hex, exponent, sign, or whitespace padding.
  // Leading-zero padding ("007", "08", "00") is rejected too: no count or position is typed
  // that way, so the documented plain-decimal rule reads it as not-a-count rather than
  // silently reading "007" as 7. A lone "0" stays valid — it is the plain spelling of zero.
  if (raw.length > 1 && raw.charCodeAt(0) === 48) return null;
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

/** The shared over-long-text message: `<subject> is <n> chars — shorten it to at most <max>`,
 * with `tail` naming where the text rides once accepted. The one home of that phrasing, used
 * by init's seed check (init.ts, "the initial prompt … every tick's prefill"), inbox-submit's
 * promptLengthProblem ("the prompt … the <role> tick's prefill"), and config-validation's
 * customLoops task and roles instructions caps (both "every tick's prefill"), so the four
 * too-long messages cannot drift apart in shape. Callers keep their own subject, cap, and
 * tail; this owns only the sentence around them. */
export function tooLongMessage(subject: string, n: number, max: number, tail: string): string {
  return `${subject} is ${n} chars — shorten it to at most ${max}: ${tail}`;
}


