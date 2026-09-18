/** Parsing one line of pi's JSONL event stream — pure string functions with no subprocess or
 * file I/O. Split out of pi.ts — which keeps the child-process integration (runPi, piArgs) and
 * whose PiStreamParser in pi-stream.ts folds those lines into a run result — because these are
 * shared by every observer that folds raw pi log lines into per-type state (progress.ts's live
 * tail, transcript.ts's renderer), and those display modules should not import from the
 * subprocess layer for a pure parse: the same separation reply-contract.ts gives the
 * sentinel/verdict text. */

/** The `type` value of one pi event line in pi's compact type-first serialization
 * (`{"type":"<event>",…}` — 100% of lines in observed logs), or null when the line does not
 * match that exact prefix (a future pi serialization, torn or foreign JSON). Callers use it as
 * a pre-filter before JSON.parse: a non-null type they do not act on is verifiably irrelevant
 * and skips the parse; null falls through to a full parse — exactly the behavior without the
 * fast path — so it can only ever skip lines whose type is verifiably uninteresting, never
 * lose output. */
export function piEventType(line: string): string | null {
  if (!line.startsWith('{"type":"')) return null;
  const end = line.indexOf('"', 9);
  return end > 9 ? line.slice(9, end) : null;
}

/** Parse one raw pi log line into an event object, or null when there is nothing for a consumer
 * acting on `types`: blank lines, torn/non-JSON lines, and lines whose compact type-first prefix
 * verifiably names a type outside `types` (the piEventType fast path) all yield null. A line
 * whose prefix does not match pi's compact shape still gets a full parse — the pre-filter can only
 * ever skip lines whose type is verifiably uninteresting, never lose output. Shared by every
 * observer that folds raw pi log lines into per-type state (progress.ts's live tail,
 * transcript.ts's renderer), so the trim → pre-filter → parse preamble and its skip-without-
 * failing policy live in one place instead of drifting between consumers of the identical log —
 * worth it because pi logs are ~97% streaming delta lines (message_update) that every consumer
 * discards after parsing them. */
export function parsePiEventLine<T>(line: string, types: ReadonlySet<string>): T | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // Cheap pre-filter before JSON.parse (see piEventType): skip the parse when the line's type is
  // verifiably not one this consumer acts on.
  const type = piEventType(trimmed);
  if (type !== null && !types.has(type)) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null; // Torn or non-JSON line — skip without failing.
  }
}

/** True when a tool_execution_update's partialResult carries new output content. bash emits
 * one empty-content update right after start, and only updates with real text prove the command
 * is alive — so stalled-tool-call tracking (src/pi.ts's warning, src/ui/progress.ts's flag)
 * moves its clock on these alone: a content-free keepalive must not mask a hang, exactly as
 * message_update deltas cannot reset the quiet watchdog. */
export function toolUpdateHasContent(partialResult: unknown): boolean {
  if (!partialResult || typeof partialResult !== "object") return false;
  const content = (partialResult as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      block &&
      typeof block === "object" &&
      typeof (block as { text?: unknown }).text === "string" &&
      (block as { text: string }).text.trim() !== "",
  );
}

/** One tool call started but not yet ended — keyed by pi's toolCallId, with a short human
 * label and the wall-clock time of its start or last content-bearing update. The shared shape
 * behind both open-call trackers: runPi's stall warning (src/pi.ts) and the dashboards' live
 * flag (src/ui/progress.ts). */
export interface OpenToolCall {
  id: string;
  label: string;
  /** Epoch ms when the call started or last received a content-bearing update. */
  lastActivityAt: number;
}

/** Fold one tool-execution event into an open-call list, mutating it in place — the single
 * definition of the tracking state machine both consumers need (see OpenToolCall): start opens
 * a call under its id with the caller-computed label (each surface names its calls for itself),
 * a content-bearing update moves that call's activity clock (a content-free keepalive must not
 * mask a hang — see toolUpdateHasContent), and end closes it. pi runs one message's tool calls
 * concurrently by default, so several can be open at once and end in completion order: entries
 * are matched by id, never by position. */
export function applyToolExecutionEvent(
  calls: OpenToolCall[],
  type: string | undefined,
  toolCallId: unknown,
  partialResult: unknown,
  label = "",
): void {
  const id = String(toolCallId ?? "");
  if (type === "tool_execution_start") {
    calls.push({ id, label, lastActivityAt: Date.now() });
  } else if (type === "tool_execution_update" && toolUpdateHasContent(partialResult)) {
    const call = calls.find((c) => c.id === id);
    if (call) call.lastActivityAt = Date.now();
  } else if (type === "tool_execution_end") {
    for (let i = calls.length - 1; i >= 0; i--) {
      const call = calls[i];
      if (call && call.id === id) calls.splice(i, 1);
    }
  }
}
