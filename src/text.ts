/** Shared text-shaping helpers for human-facing one-line text — the observability layer's
 * display labels (live progress, transcripts), tick commit subjects and body fields, and
 * build-check reason lines — plus number and token formats: whitespace collapsing, ellipsis
 * truncation, compact token counts, abbreviated commit hashes, money formats, and plain-decimal
 * integer parsing. (Local date/time formatting and calendar-day arithmetic live in
 * datetime.ts; terminal-column geometry — the wcwidth table and the displayWidth/
 * padToWidth/clipToWidth clippers — lives in text-width.ts; the fleet's shared wording
 * fragments — the red-main phrase, the pause-reason suffix, the hold, budget, and backend
 * phrasings, tool-call labels — live in phrases.ts.) Presentation only:
 * depends on node built-ins alone, so any layer (harness or observer) can import it without
 * reaching into another module's internals — and the collapse/truncation/compaction/
 * abbreviation semantics live in exactly one place instead of drifting per consumer. */

/** Collapse every run of whitespace to a single space and trim both ends — the shape every
 * one-line label takes before display (multi-line pi text, command strings, error messages). */
export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Levenshtein edit distance between two short tokens (command names, config keys — a
 * handful of chars, so the two-row DP table is trivially cheap). */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row.push(
        Math.min(
          prev[j]! + 1, // Deletion.
          row[j - 1]! + 1, // Insertion.
          prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1), // Substitution.
        ),
      );
    }
    prev = row;
  }
  return prev[b.length]!;
}

/** The candidate closest to a mistyped `input` by case-insensitive edit distance, or null
 * when nothing is close enough to suggest: the "did you mean" behind typo'd command names
 * (help.ts) and config keys (config-write.ts, config-commands.ts). Capped at `maxDistance`
 * (two edits by default — a typo's distance, not a different word's), so only a near miss
 * gets a hint and the suggestion can never fire as an auto-correction; the caller still
 * prints the full valid list, so a suggestion only annotates it. */
export function suggestClosest(
  input: string,
  candidates: readonly string[],
  maxDistance = 2,
): string | null {
  const needle = input.toLowerCase();
  let best: { candidate: string; distance: number } | null = null;
  for (const candidate of candidates) {
    const distance = editDistance(needle, candidate.toLowerCase());
    if (best === null || distance < best.distance) best = { candidate, distance };
  }
  return best !== null && best.distance <= maxDistance ? best.candidate : null;
}

/** The " — did you mean \`<suggestion>\`?" annotation for a suggestion suggestClosest (or a
 * caller's own suggestion) returned — the empty string when there is none. One home for the
 * wording so every unknown-role, unknown-command, unknown-config-key, and unknown-help-topic
 * message spells the hint the same way, and its tests can pin it once. */
export function didYouMean(suggestion: string | null): string {
  return suggestion ? ` — did you mean \`${suggestion}\`?` : "";
}

/** suggestClosest and didYouMean composed: the " — did you mean `x`?" suffix for a mistyped
 * `input` against `candidates`, the empty string when nothing is close enough to suggest. The
 * four unknown-X error sites (roles.ts's unknownRoleMessage, config-write.ts's
 * unknownConfigKeyError and its role-field error, gui-args.ts's rejectBadRole) render the hint
 * through this one composition so the two-step pairing cannot drift; callers still print the
 * full valid list themselves — a suggestion only annotates it. (cli.ts's unknown-command and
 * no-help-topic errors stay on the bare halves: their suggestion arrives from help.ts's
 * suggestCommand, which derives the candidate list from the help text.) */
export function typoSuffix(input: string, candidates: readonly string[]): string {
  return didYouMean(suggestClosest(input, candidates));
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


