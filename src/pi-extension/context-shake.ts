/**
 * Bundled pi extension: when a run crosses 70% of its context window, reclaim the space held
 * by old, bulky `read` and `bash` tool results by replacing each with a short pointer the model
 * can follow back to the full text. Loaded on every pi run via `-e <this file>` from
 * src/pi/pi-args.ts, after bounded-output and before context-budget.
 *
 * Why: on a small-window fallback model (oMLX's ~127k–258k windows), the context-budget notes
 * tell the model it is filling up and pi eventually compacts with a lossy LLM summary that
 * discards the run's reads. omp's `shake` reclaims that context without a model call: replace
 * old tool results with recoverable references and keep the recent window intact. pi 1.0.0 can
 * do the same from an extension — a `turn_end` handler appends persisted `context_edit` entries
 * (pi docs, extensions.md "Events and concurrency"; session-format.md "ContextEditEntry"). On a
 * large-window primary (1M) the 70% line sits far above the largest fleet tick, so the
 * extension plans nothing and costs nothing there.
 *
 * The selection logic is a pure, exported function (`shakePlan`) so every rule is unit-testable
 * offline without pi; the default export is the thin adapter that maps pi's `turn_end` context
 * entries onto it, resolves a bash result's full-output path with full-output's
 * `writeFullOutput`, and appends the one-line summary note to the next `tool_result` (as
 * context-budget does with its threshold notes).
 */

import { nonNegativeNumber } from "../files/json-object.js";
import { compactTokens } from "../text/format.js";
import { writeFullOutput } from "./full-output.js";
import { appendToolResultNote } from "./tool-result-content.js";
import { readContextUsage } from "./context-usage.js";

/** The fill percentage at which the first shake pass runs. */
export const SHAKE_PERCENT = 70;
/** The fill percentage at which a second pass runs, only when the first did not bring the run
 * back under `SHAKE_PERCENT` (the note-heavy path climbs here again). */
export const SHAKE_MAX_PERCENT = 85;
/** The newest slice of context, in estimated tokens, that is never elided — the model still
 * needs what it was just reading. */
export const SHAKE_PROTECTED_TOKENS = 20_000;
/** A tool result shorter than this is left alone: its pointer would save little. */
export const SHAKE_MIN_CHARS = 2_000;
/** A pass that would reclaim fewer than this many estimated tokens is not worth the edit. */
export const SHAKE_MIN_RECLAIM_TOKENS = 10_000;

/** The fixed prefix of every elision pointer, used to recognize a result that was already
 * elided (and must never be elided again). */
export const ELIDED_PREFIX = "[elided by tumwater:";

/** A conservative characters-to-tokens estimate: four characters per token. It only has to be
 * monotonic and roughly right for a threshold decision, not exact. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** One model-visible message, flattened to what the shake planner needs. */
export interface ShakeMessage {
  /** The session entry id a `context_edit` targets, when this message is editable. */
  entryId?: string;
  role?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  text: string;
  /** A bash result's known full-output path (`details.fullOutputPath`), when pi set one. */
  fullOutputPath?: string;
  /** A read result's tool input, for the pointer's file:range. */
  readInput?: { path?: string; offset?: number; limit?: number };
}

/** A context-usage snapshot, matching the fields of pi's `ctx.getContextUsage()`. */
export interface ShakeUsage {
  tokens?: number | null;
  contextWindow?: number;
  percent?: number | null;
}

/** A planned replacement of one tool result. */
export interface ShakeEdit {
  targetId: string;
  toolName: "read" | "bash";
  replacement: string;
  reclaimedTokens: number;
}

/** What a shake pass decided. */
export interface ShakePlan {
  edits: ShakeEdit[];
  reclaimedTokens: number;
  elidedCount: number;
}

/** Persist a bash result's full text and return its path, or null when there is nowhere to
 * write. Injected so the planner stays testable without the filesystem. */
export type FullOutputWriter = (text: string, toolCallId?: string) => string | null;

const EMPTY_PLAN: ShakePlan = { edits: [], reclaimedTokens: 0, elidedCount: 0 };

/** The usage's fill percentage, or null when it cannot be known. */
function percentOf(usage: ShakeUsage): number | null {
  if (usage.percent !== null && usage.percent !== undefined && Number.isFinite(usage.percent)) {
    return usage.percent;
  }
  // Both ratio inputs are read through nonNegativeNumber: a NaN/Infinity/negative/string wire
  // value is as unusable as a missing one, and a NaN ratio would slip past shakePlan's
  // `percent < SHAKE_PERCENT` guard (every comparison against NaN is false) and plan a pass on
  // an unknown fill. A non-positive window has no ratio either.
  const tokens = nonNegativeNumber(usage.tokens, null);
  const window = nonNegativeNumber(usage.contextWindow, null);
  if (tokens !== null && window !== null && window > 0) return (tokens / window) * 100;
  return null;
}

/** The number of whole code points in `text` — the "N chars" the pointer states. */
function charCount(text: string): number {
  return Array.from(text).length;
}

/** The replacement pointer for one selected result. A bash result names its full-output path
 * (the caller guarantees one exists); a read result names its file and line range. */
function replacementFor(msg: ShakeMessage, fullOutputPath: string | null): string {
  const chars = charCount(msg.text);
  if (msg.toolName === "bash") {
    return `[elided by tumwater: ${chars} chars; full output in ${fullOutputPath}]`;
  }
  const path = msg.readInput?.path ?? "the file";
  const start = typeof msg.readInput?.offset === "number" && msg.readInput.offset > 0 ? msg.readInput.offset : 1;
  const lines = msg.text === "" ? 0 : msg.text.split("\n").length;
  const end = start + Math.max(1, lines) - 1;
  return `[elided by tumwater: ${chars} chars of ${path}:${start}-${end}; re-read the range if you still need it]`;
}

/** Whether one message is even a candidate, ignoring the reclaim floor: a bulky, non-error,
 * not-already-elided read or bash result that sits outside the protected newest slice. */
function isCandidate(msg: ShakeMessage, newerTokens: number): boolean {
  if (newerTokens < SHAKE_PROTECTED_TOKENS) return false;
  if (msg.role !== "toolResult") return false;
  if (msg.toolName !== "read" && msg.toolName !== "bash") return false;
  if (msg.isError === true) return false;
  if (!msg.entryId) return false;
  if (msg.text.length <= SHAKE_MIN_CHARS) return false;
  if (msg.text.startsWith(ELIDED_PREFIX)) return false;
  return true;
}

/**
 * Plan a shake pass: the `context_edit` replacements that reclaim the most space from old
 * bulky tool results. Empty unless the run is at or above `SHAKE_PERCENT`, something outside
 * the newest `SHAKE_PROTECTED_TOKENS` is reclaimable, and the pass clears
 * `SHAKE_MIN_RECLAIM_TOKENS` together. Deterministic and filesystem-free except the injected
 * `writeFullOutput`, which is only called for a bash result pi has not already persisted.
 */
export function shakePlan(
  messages: ShakeMessage[],
  usage: ShakeUsage,
  writeFullOutput?: FullOutputWriter | null,
): ShakePlan {
  const percent = percentOf(usage);
  if (percent === null || percent < SHAKE_PERCENT) return EMPTY_PLAN;

  // Tokens newer than each message, so a candidate is one the model has already moved past.
  const newerTokens: number[] = new Array<number>(messages.length).fill(0);
  let running = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    newerTokens[i] = running;
    running += estimateTokens(messages[i]?.text ?? "");
  }

  const candidates = messages.filter((msg, i) => isCandidate(msg, newerTokens[i] ?? 0));
  // The pointer is far shorter than the result it replaces, so the full text's tokens are a
  // safe upper bound on the reclaim; bail before touching the writer when even that is short.
  const upperBound = candidates.reduce((sum, msg) => sum + estimateTokens(msg.text), 0);
  if (upperBound < SHAKE_MIN_RECLAIM_TOKENS) return EMPTY_PLAN;

  const edits: ShakeEdit[] = [];
  let reclaimedTokens = 0;
  for (const msg of candidates) {
    let fullOutputPath: string | null = null;
    if (msg.toolName === "bash") {
      fullOutputPath = msg.fullOutputPath ?? writeFullOutput?.(msg.text, msg.toolCallId) ?? null;
      // No recoverable path means eliding would lose the output outright: keep the result.
      if (!fullOutputPath) continue;
    }
    const replacement = replacementFor(msg, fullOutputPath);
    const reclaimed = Math.max(0, estimateTokens(msg.text) - estimateTokens(replacement));
    edits.push({ targetId: msg.entryId!, toolName: msg.toolName as "read" | "bash", replacement, reclaimedTokens: reclaimed });
    reclaimedTokens += reclaimed;
  }
  if (reclaimedTokens < SHAKE_MIN_RECLAIM_TOKENS) return EMPTY_PLAN;
  return { edits, reclaimedTokens, elidedCount: edits.length };
}

/** The one-line note that tells the model what happened, appended to the next tool result. */
export function shakeNote(elidedCount: number, reclaimedTokens: number): string {
  return `[tumwater: elided ${elidedCount} old tool results (~${compactTokens(reclaimedTokens)} tokens); each pointer says where the full text is]`;
}

/** Minimal structural types for pi's extension API — pi itself loads this file, so the real
 * types are not needed at compile time and stay out of the dependency tree. */
interface TextBlock {
  type?: string;
  text?: string;
}

interface ToolCallBlock {
  type?: string;
  id?: string;
  name?: string;
  arguments?: { path?: string; offset?: number; limit?: number };
}

interface MessageLike {
  role?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  content?: unknown;
  details?: { fullOutputPath?: string };
}

interface ProjectedEntry {
  sourceEntry?: { id?: string };
  messages?: MessageLike[];
}

interface TurnEndLikeEvent {
  context?: { contextEntries?: ProjectedEntry[] };
}

interface ToolResultLikeEvent {
  content?: unknown;
}

interface ContextLike {
  getContextUsage?: () => ShakeUsage | undefined;
}

interface PiExtensionApi {
  on(
    event: "turn_end",
    handler: (event: TurnEndLikeEvent, ctx?: ContextLike) => { entries: ShakeContextEditDraft[] } | undefined,
  ): void;
  on(
    event: "tool_result",
    handler: (event: ToolResultLikeEvent) => { content: Array<{ type: string; text: string }> } | undefined,
  ): void;
}

/** A draft entry pi appends at the actionable boundary: one replacement edit. pi's
 * `appendContextEdit` (dist/core/session-manager.js) rejects a bare string and requires a
 * `{ content: string | array }` object; a string content is normalized to one text block for a
 * tool-result target. */
interface ShakeContextEditDraft {
  type: "context_edit";
  targetId: string;
  replacement: { content: string };
}

/** Flatten a turn_end event's projected context into the ordered messages the planner reads,
 * mapping each assistant tool call's input onto the tool result it produced. */
export function shakeMessages(event: TurnEndLikeEvent): ShakeMessage[] {
  const calls = new Map<string, ToolCallBlock>();
  const out: ShakeMessage[] = [];
  for (const entry of event.context?.contextEntries ?? []) {
    for (const msg of entry.messages ?? []) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const part of msg.content as ToolCallBlock[]) {
          if (part?.type === "toolCall" && typeof part.id === "string") calls.set(part.id, part);
        }
      }
      const message: ShakeMessage = { text: textOf(msg) };
      if (entry.sourceEntry?.id) message.entryId = entry.sourceEntry.id;
      if (msg.role) message.role = msg.role;
      if (msg.role === "toolResult") {
        if (msg.toolName) message.toolName = msg.toolName;
        if (msg.toolCallId) message.toolCallId = msg.toolCallId;
        if (msg.isError !== undefined) message.isError = msg.isError;
        if (msg.details?.fullOutputPath) message.fullOutputPath = msg.details.fullOutputPath;
        const call = msg.toolCallId ? calls.get(msg.toolCallId) : undefined;
        if (call?.name === "read") {
          message.readInput = {
            path: call.arguments?.path,
            offset: call.arguments?.offset,
            limit: call.arguments?.limit,
          };
        }
      }
      out.push(message);
    }
  }
  return out;
}

/** The plain text of a message's content array (or string). */
function textOf(msg: MessageLike): string {
  if (!Array.isArray(msg.content)) return "";
  return (msg.content as Array<TextBlock | string>)
    .filter((part): part is TextBlock => typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n");
}

/** The pi extension entry point: shake at 70% (and again at 85% when the first pass did not
 * hold), leaving each pointer in the context and the one-line summary on the next result. */
export default function contextShake(pi: PiExtensionApi): void {
  let lastShake = 0;
  let pendingNote: string | null = null;

  pi.on("turn_end", (event, ctx) => {
    const usage = readContextUsage(ctx);
    if (!usage) return undefined;
    const percent = percentOf(usage);
    if (percent === null) return undefined;

    // One pass per crossing: 70% first, then 85% only if the run climbed back here.
    let threshold = 0;
    if (lastShake < SHAKE_PERCENT && percent >= SHAKE_PERCENT) threshold = SHAKE_PERCENT;
    else if (lastShake < SHAKE_MAX_PERCENT && percent >= SHAKE_MAX_PERCENT) threshold = SHAKE_MAX_PERCENT;
    if (threshold === 0) return undefined;
    lastShake = threshold;

    const plan = shakePlan(shakeMessages(event), usage, (text, toolCallId) => writeFullOutput(text, toolCallId));
    if (plan.edits.length === 0) return undefined;
    pendingNote = shakeNote(plan.elidedCount, plan.reclaimedTokens);
    const entries: ShakeContextEditDraft[] = plan.edits.map((edit) => ({
      type: "context_edit",
      targetId: edit.targetId,
      replacement: { content: edit.replacement },
    }));
    return { entries };
  });

  pi.on("tool_result", (event) => {
    if (pendingNote === null) return undefined;
    const note = pendingNote;
    pendingNote = null;
    return appendToolResultNote(event.content, note);
  });
}
