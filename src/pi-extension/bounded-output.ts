/**
 * Bundled pi extension: bounds oversized tool results so a single read or command cannot
 * flood the tick's context window (PLANS.md "Bound tool output head+tail with a tumwater
 * pi extension"). Loaded on every pi run via `-e <this file>` from src/pi.ts.
 *
 * All bounding logic lives in pure, filesystem-free exported functions — `boundText`,
 * `boundReadResult`, `boundBashResult` — so every rule is unit-testable offline without
 * pi. The default export is a thin adapter that maps pi's `tool_result` event fields onto
 * them and returns a partial `{ content }` patch (pi docs, extensions.md "tool_result").
 *
 * Limits are constants on purpose (opinionated defaults over configuration). The read
 * limit (~12k chars ≈ 300 lines) mirrors the prompt's CONTEXT_BUDGET_RULE; the bash limit
 * is looser because test logs and build output legitimately need more tail.
 */

import fs from "node:fs";
import path from "node:path";

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
const chars = (text: string): string[] => Array.from(text);

/** Core bounding: keep head+tail around a marker naming the omitted character count and,
 * when known, where the complete output lives. Under the limit the text is returned
 * byte-identical. The result is always at most `limitChars` code points long. */
export function boundText(
  text: string,
  limitChars: number,
  fullPath?: string | null,
): string {
  if (!text) return text;
  const cps = chars(text);
  if (cps.length <= limitChars) return text;

  const marker = (omitted: number): string =>
    `...${omitted} chars truncated${fullPath ? `; complete output in ${fullPath}` : ""}...`;

  // Reserve a little slack so the final marker (whose digit count grows with the real
  // omitted total) never pushes the result past the limit.
  const markerLen = chars(marker(0)).length;
  const budget = limitChars - markerLen - 12;
  let headLen = Math.floor(budget / 2);
  let tailLen = budget - headLen;

  let result = cps.slice(0, headLen).join("") +
    marker(cps.length - headLen - tailLen) +
    cps.slice(cps.length - tailLen).join("");
  // Safety valve for pathological marker growth — trim the tail until it fits.
  while (chars(result).length > limitChars && tailLen > 0) {
    tailLen -= 1;
    result = cps.slice(0, headLen).join("") +
      marker(cps.length - headLen - tailLen) +
      cps.slice(cps.length - tailLen).join("");
  }
  return result;
}

/** Snap a head cut index forward so the head ends at a line boundary (the kept head ends
 * with a newline). Gives up and returns the raw cut if no newline is found within
 * `maxDrift` code points — a minified one-liner should not swallow the whole budget. */
const snapHeadForward = (cps: string[], cut: number, maxDrift: number): number => {
  const target = Math.min(cut + maxDrift, cps.length);
  while (cut < target && cps[cut - 1] !== "\n") cut += 1;
  return cut;
};

/** Snap a tail start index forward so the tail begins at a line boundary. */
const snapTailStartForward = (cps: string[], start: number, maxDrift: number): number => {
  const target = Math.min(start + maxDrift, cps.length);
  while (start < target && start > 0 && cps[start - 1] !== "\n") start += 1;
  return start;
};

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
  const cps = chars(text);
  if (cps.length <= limitChars) return text;

  const marker = (omitted: number): string =>
    `...${omitted} chars of this read were omitted — re-read ${input?.path ?? "the file"} with offset/limit to see the missing middle...`;

  const markerLen = chars(marker(0)).length;
  const half = Math.floor((limitChars - markerLen - SNAP_SLACK) / 2);
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
  if (chars(text).length <= limitChars) return text;
  const fullPath = details?.fullOutputPath ?? writeFullOutput?.(text) ?? null;
  return boundText(text, limitChars, fullPath);
}

/** Walk up from `startDir` looking for a `.tumwater/` directory — the harness root. Role
 * worktrees (`.tumwater/worktrees/<role>`) and lander worktrees reach it two levels up;
 * a harness root carries it directly. Returns null when no ancestor has one, so a bare
 * pi run outside the harness writes nothing. Exported for tests. */
export function findTumwaterRoot(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      if (fs.statSync(path.join(dir, ".tumwater")).isDirectory()) return dir;
    } catch {
      // Not here — keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Persist a full tool output under the harness's gitignored `.tumwater/` area and return
 * its path, or null when there is no harness root (or the write fails). Files are named
 * by `toolCallId` because parallel tool mode can interleave tool_result events. The
 * orchestrator's retention passes prune this directory with the fleet's
 * sessionRetentionDays window (toolOutputDir in src/paths.ts), so a pointer to a full
 * output stays readable while its tick is recent and never accumulates forever. */
export function writeFullOutput(
  text: string,
  toolCallId: unknown,
  startDir: string = process.cwd(),
): string | null {
  const root = findTumwaterRoot(startDir);
  if (!root) return null;
  try {
    const dir = path.join(root, ".tumwater", "log", "tool-output");
    fs.mkdirSync(dir, { recursive: true });
    const id = typeof toolCallId === "string" && toolCallId
      ? toolCallId.replace(/[^\w-]/g, "_")
      : `result-${Date.now()}`;
    const file = path.join(dir, `${id}.log`);
    fs.writeFileSync(file, text, "utf-8");
    return file;
  } catch {
    return null;
  }
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
