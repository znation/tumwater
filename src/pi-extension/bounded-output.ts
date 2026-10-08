/**
 * Bundled pi extension: bounds oversized tool results so a single read or command cannot
 * flood the tick's context window (PLANS.md "Bound tool output head+tail with a tumwater
 * pi extension"). Loaded on every pi run via `-e <this file>` from src/pi/pi.ts.
 *
 * All bounding logic lives in pure, filesystem-free exported functions — `boundText`,
 * `boundReadResult`, `boundBashResult` — so every rule is unit-testable offline without
 * pi. The default export is a thin adapter that maps pi's `tool_result` event fields onto
 * them and returns a partial `{ content }` patch (pi docs, extensions.md "tool_result").
 * The one side effect it needs — persisting a bash result pi did not truncate, so the
 * bound marker can point at the complete text — lives in full-output.ts, which finds the
 * harness root and writes the file.
 *
 * Limits are constants on purpose (opinionated defaults over configuration). The read
 * limit (~12k chars ≈ 300 lines) mirrors the prompt's CONTEXT_BUDGET_RULE; the bash limit
 * is looser because test logs and build output legitimately need more tail.
 */

import { writeFullOutput } from "./full-output.js";

/** Char budget for a `read` tool result (~300 lines, matching CONTEXT_BUDGET_RULE). */
export const READ_LIMIT_CHARS = 12_000;
/** Char budget for a `bash` tool result — looser, so test/build tails survive. */
export const BASH_LIMIT_CHARS = 16_000;

/** Extra code points reserved when snapping cut points to line boundaries, so the
 * snapped head+tail plus marker still fit inside the limit even after rounding. */
const SNAP_SLACK = 240;

interface ReadInput {
  path?: string;
  offset?: number;
  limit?: number;
}

interface BashDetails {
  fullOutputPath?: string;
}

/** Split a string into whole code points, so multi-byte UTF-8 is never cut mid-character. */
function chars(text: string): string[] {
  return Array.from(text);
}

/** The bounders' shared under-limit test. A string's code-point count never exceeds its
 * UTF-16 length, so a length within the limit proves the text is under the limit without
 * allocating the code-point array — the common case for every short-enough result, and
 * the reason boundBashResult can decide "never earns a disk write" cheaply. Returns the
 * code-point array when the text needs bounding, null when it passes through untouched. */
function cpsWhenOverLimit(text: string, limitChars: number): string[] | null {
  if (text.length <= limitChars) return null;
  const cps = chars(text);
  return cps.length <= limitChars ? null : cps;
}

/** Core bounding: keep head+tail around a marker naming the omitted character count and,
 * when known, where the complete output lives. Under the limit the text is returned
 * byte-identical. The result is always at most `limitChars` code points long. */
export function boundText(
  text: string,
  limitChars: number,
  fullPath?: string | null,
): string {
  if (!text) return text;
  const cps = cpsWhenOverLimit(text, limitChars);
  if (cps === null) return text;

  const marker = (omitted: number): string =>
    `...${omitted} chars truncated${fullPath ? `; complete output in ${fullPath}` : ""}...`;

  // Reserve a little slack so the final marker (whose digit count grows with the real
  // omitted total) never pushes the result past the limit — 12 digits covers any text
  // short of a trillion code points.
  const markerLen = chars(marker(0)).length;
  const budget = limitChars - markerLen - 12;
  // A marker longer than the whole limit — a very long full-output path beside a small
  // budget — drives the budget negative, and negative slice bounds would then keep nearly
  // the entire text: the exact flood bounding exists to prevent. Clamp to zero so the
  // worst case is the marker alone.
  const headLen = Math.max(0, Math.floor(budget / 2));
  const tailLen = Math.max(0, budget - headLen);

  let result = cps.slice(0, headLen).join("") +
    marker(cps.length - headLen - tailLen) +
    cps.slice(cps.length - tailLen).join("");
  // Last resort when even the marker alone exceeds the limit (a path longer than the
  // budget): a hard cut keeps the at-most-limit contract instead of returning it all.
  if (chars(result).length > limitChars) result = chars(result).slice(0, limitChars).join("");
  return result;
}

/** Snap a head cut index forward so the head ends at a line boundary (the kept head ends
 * with a newline). Gives up and returns the raw cut if no newline is found within
 * `maxDrift` code points — a minified one-liner should not swallow the whole budget. */
function snapHeadForward(cps: string[], cut: number, maxDrift: number): number {
  const target = Math.min(cut + maxDrift, cps.length);
  while (cut < target && cps[cut - 1] !== "\n") cut += 1;
  return cut;
}

/** Snap a tail start index forward so the tail begins at a line boundary. */
function snapTailStartForward(cps: string[], start: number, maxDrift: number): number {
  const target = Math.min(start + maxDrift, cps.length);
  while (start < target && start > 0 && cps[start - 1] !== "\n") start += 1;
  return start;
}

/** Bound a `read` result: head+tail around a marker that tells the model to re-read the
 * file with offset/limit for the missing middle — the file itself is the complete output,
 * so nothing is copied to disk. Results the model already ranged (input.offset or
 * input.limit set), short texts, and empty texts pass through untouched. Cut points snap
 * to line boundaries so every kept line stays whole. */
export function boundReadResult(
  text: string,
  input?: ReadInput | null,
  limitChars: number = READ_LIMIT_CHARS,
): string {
  if (!text) return text;
  if (input && (input.offset !== undefined || input.limit !== undefined)) return text;
  const cps = cpsWhenOverLimit(text, limitChars);
  if (cps === null) return text;

  const marker = (omitted: number): string =>
    `...${omitted} chars of this read were omitted — re-read ${input?.path ?? "the file"} with offset/limit to see the missing middle...`;

  const markerLen = chars(marker(0)).length;
  // The marker embeds the file path, so a very long path beside a small limit drives the
  // per-side budget negative — and negative cut indices send the snap helpers past the
  // text's ends: the "head" slice then keeps only the first few characters while the tail
  // slice (start past the end) keeps nothing, the omitted count overcounts by the negative
  // half, and the marker claims a missing middle that is really everything but the first
  // line. Clamp to zero so the worst case is a sliver of head plus the marker alone — the
  // same degenerate-but-honest bound the boundText clamp below accepts.
  const half = Math.max(0, Math.floor((limitChars - markerLen - SNAP_SLACK) / 2));
  const headEnd = snapHeadForward(cps, half, 2_000);
  const tailStart = snapTailStartForward(cps, cps.length - half, 2_000);
  const omitted = tailStart - headEnd;
  if (omitted <= 0) return boundText(text, limitChars, null);

  const result = cps.slice(0, headEnd).join("") + marker(omitted) + cps.slice(tailStart).join("");
  // Snapping may have grown the result past the budget (long lines) — fall back to the
  // plain character cut, which is still whole-code-point safe.
  if (chars(result).length > limitChars) return boundText(text, limitChars, null);
  return result;
}

/** Bound a `bash` result: head+tail around a marker pointing at the complete output.
 * pi's own full-output file (`details.fullOutputPath`, set whenever pi's bash tool
 * truncates) is preferred; otherwise `writeFullOutput` persists the full text and returns
 * its path, or null when there is nowhere sensible to write — in that case the marker
 * simply carries no path and nothing is written. */
export function boundBashResult(
  text: string,
  details?: BashDetails | null,
  writeFullOutput?: ((text: string) => string | null) | null,
  limitChars: number = BASH_LIMIT_CHARS,
): string {
  if (!text) return text;
  // The second half of the shared test matters before writeFullOutput: astral-heavy text
  // can have a UTF-16 length past the limit while its code-point count stays within it —
  // still under-limit, so it must pass through here: an output that will not be truncated
  // never earns a disk write.
  if (cpsWhenOverLimit(text, limitChars) === null) return text;
  const fullPath = details?.fullOutputPath ?? writeFullOutput?.(text) ?? null;
  return boundText(text, limitChars, fullPath);
}

/** Minimal structural types for pi's extension API — pi itself loads this file, so the
 * real types are not needed at compile time and stay out of the dependency tree. */
interface BoundedToolResultEvent {
  toolName?: string;
  toolCallId?: string;
  input?: ReadInput;
  details?: BashDetails;
  content?: Array<{ type?: string; text?: string }>;
}

interface PiExtensionApi {
  on(event: string, handler: (event: BoundedToolResultEvent) => unknown): void;
}

/** The pi extension entry point: bound oversized read and bash results in place. */
export default function boundedOutput(pi: PiExtensionApi): void {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "read" && event.toolName !== "bash") return undefined;
    const blocks = event.content;
    if (!Array.isArray(blocks)) return undefined;
    // Only rewrite plain text results — image attachments pass through untouched.
    const textBlock = blocks.find((b) => b?.type === "text" && typeof b.text === "string");
    if (!textBlock || typeof textBlock.text !== "string") return undefined;

    const bounded = event.toolName === "read"
      ? boundReadResult(textBlock.text, event.input)
      : boundBashResult(textBlock.text, event.details, (text) =>
        writeFullOutput(text, event.toolCallId));
    if (bounded === textBlock.text) return undefined;
    return { content: [{ type: "text", text: bounded }] };
  });
}
