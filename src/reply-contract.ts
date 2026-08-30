/** The machine-detectable half of the reply contract every pi run must follow: the
 * TUMWATER_NOTHING_TO_DO sentinel a loop emits when it found nothing to do, the
 * TUMWATER_REFUSED line a loop emits when it declines its task, and the review gate's VERDICT
 * line. prompt.ts declares this contract in prose (the prompts tell pi what to emit); this
 * module owns the constants and detection the harness uses to parse pi's replies — so the
 * subprocess layer (pi.ts) and the review gate (review.ts) detect it without reaching into
 * prompt construction, and the verdict line's shape lives in exactly one place instead of
 * drifting between detector and parser. */

/** Sentinel a loop's pi run outputs when it found nothing worth doing. */
export const NOTHING_TO_DO = "TUMWATER_NOTHING_TO_DO";

/** True when `text` declares there was nothing to do (pi.ts's stream parser scans every
 * assistant message, so a declaration in an intermediate turn survives). */
export function isNothingToDo(text: string): boolean {
  return text.includes(NOTHING_TO_DO);
}

/** Sentinel a loop's pi run outputs when it declines its task (see plans/refusal-and-thrash.md):
 * `TUMWATER_REFUSED: <one-line reason>`. The reason is the durable objection — it becomes the
 * commit subject of the refusal note and the tick's lastSummary. */
export const REFUSED_SENTINEL = "TUMWATER_REFUSED";

/** The trimmed remainder of the first line that starts with `<label>:` (leading whitespace on
 * the line allowed); null when no such line carries content. Shared by every parser that pulls a
 * labeled field out of pi's final reply — SUMMARY/WHY/RISK/VERIFIED in commit-message.ts and the
 * TUMWATER_REFUSED reason here — so the anchored-line shape lives in one place instead of drifting. */
export function labeledLine(text: string, label: string): string | null {
  const match = text.match(new RegExp(`^\\s*${label}:\\s*(.+)\\s*$`, "m"));
  return match?.[1] ? match[1].trim() : null;
}

/** Extract the one-line reason from a TUMWATER_REFUSED sentinel line; null when no such line
 * exists. Anchored at line start like the VERDICT line, so prose that merely mentions the
 * sentinel mid-sentence cannot set the reason (pi.ts's boolean detection is deliberately
 * looser — a whole-reply scan, matching the nothing-to-do sentinel). */
export function extractRefusal(text: string): string | null {
  return labeledLine(text, REFUSED_SENTINEL);
}

// The review gate's verdict line as stated in buildReviewPrompt (prompt.ts): the reviewer
// ends with exactly `VERDICT: approve` or `VERDICT: reject`. Anchored at line start so prose
// that merely mentions "VERDICT:" mid-sentence cannot set the outcome. One source of truth,
// two derived regexes — stateless detection for pi.ts's per-message scan, and a global one
// for review.ts's extraction (matchAll clones it internally, so sharing is safe).
const VERDICT_LINE_SOURCE = "^VERDICT:\\s*(approve|reject)\\b";
const VERDICT_LINE = new RegExp(VERDICT_LINE_SOURCE, "m");
const VERDICT_LINES = new RegExp(VERDICT_LINE_SOURCE, "gm");

/** True when `text` carries a parseable verdict line (pi.ts's stream parser records the
 * last assistant message carrying one as the run's verdictText). */
export function hasVerdictLine(text: string): boolean {
  return VERDICT_LINE.test(text);
}

/** One verdict line found in `text`: where it sits and which way it went. */
export interface VerdictMatch {
  /** Index of the line's start in `text`. */
  index: number;
  /** Index just past the line's end — the reviewer's reasons follow here. */
  end: number;
  verdict: "approve" | "reject";
}

/** Every verdict line in `text`, in order (the prompt asks for exactly one, and the last
 * wins — review.ts's parseVerdict takes the final match and reads its reasons from after it). */
export function verdictLines(text: string): VerdictMatch[] {
  const out: VerdictMatch[] = [];
  for (const m of text.matchAll(VERDICT_LINES)) {
    if (!m[1]) continue; // Unreachable: the group is required by the pattern.
    const index = m.index ?? 0;
    out.push({ index, end: index + m[0].length, verdict: m[1] as "approve" | "reject" });
  }
  return out;
}
