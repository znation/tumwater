import { extractRefusal, hasVerdictLine, isNegatedRefusal, isNothingToDo } from "./reply-contract.js";
import {
  applyToolExecutionEvent,
  piEventType,
  toolCallCommand,
  toolUpdateHasContent,
  type OpenToolCall,
} from "./pi-event-line.js";
import { describeToolCall } from "./text.js";
import { parseJsonObject } from "./json-object.js";

/** Accumulating pi's JSON event stream into a run result — pure parsing with no subprocess or
 * file I/O. Split out of pi.ts — which keeps the child-process integration (runPi,
 * hasResumableSession, and the stderr crash signature) — so the parser can be unit-tested and
 * reasoned about without spawning a process, the same separation pi-event-line.ts gives the
 * per-line parse and reply-contract.ts the sentinel/verdict text. */

interface PiMessage {
  role: string;
  content?: Array<{ type: string; text?: string }>;
  usage?: { totalTokens?: number; output?: number; cost?: { total?: number } };
  stopReason?: string;
  errorMessage?: string;
}

/** The fields feedLine reads off one parsed pi event line. pi's stream is one JSON object per
 * line, so anything that is not an object (a scalar, `null`, or an array) is torn or foreign
 * noise — see the object check in feedLine. */
interface PiStreamEvent {
  type?: string;
  message?: PiMessage;
  errorMessage?: string;
  finalError?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
}

/** Extract the concatenated text blocks of a pi message. */
function messageText(msg: PiMessage): string {
  return (msg.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

/** Context-overflow errors often surface only in retry events, not the final message,
 * so feedLine matches this against every error text it sees. Stateless (no `g` flag), so
 * one shared instance is safe for repeated .test() calls.
 * Module-private: only PiStreamParser.feedLine below matches against it. */
const CONTEXT_ERROR = /context (size|length|window)?\s*(has been |was )?exceeded|exceeds? (the )?context|too (long|large) for .*context/i;

/** LM Studio killed predict streams idle >600 s (e.g. the machine slept mid-run) and reported
 * it back through pi as a server error on an assistant message. Fresh requests succeed
 * within seconds of a wake, so this is retryable — unlike every other error class. Kept after
 * the 2026-09-14 move to oMLX: defensive, and oMLX has no equivalent message.
 * Module-private: only PiStreamParser.feedLine below matches against it. */
const TRANSIENT_SERVER_TIMEOUT = /predict stream timed out/i;

/** The provider rejecting the request with HTTP 429 — rate limiting. This is the world saying
 * "later", not the session failing: the fleet's single largest error source (BUGS.md 2026-09-21)
 * and by definition retryable. Matched against every error text feedLine sees, since pi renders
 * the provider's status and message variously ("429 \"Rate limit exceeded\"", OpenAI's
 * "Too Many Requests"). Retry-After, when the provider echoes it into the error text, is
 * captured in retryAfterSeconds. Module-private: only PiStreamParser.feedLine matches it. */
const TRANSIENT_RATE_LIMIT = /\b429\b|too many requests|rate limit/i;

/** The provider's Retry-After hint inside a rate-limit error text — seconds to wait before
 * retrying. Tolerates the spellings error text actually uses ("Retry-After: 30",
 * "retry after 30s"). Module-private: only PiStreamParser.feedLine matches it. */
const RETRY_AFTER = /retry[- ]after:?\s*(\d{1,4})/i;

/** The kinds of provider-wide failure that are NOT rate limiting: the backend itself is down,
 * refusing connections, or cannot serve the model at all. The fleet-wide hold (src/
 * fleet-hold.ts) groups a storm by kind — two roles hitting the same kind is one storm,
 * two hitting different kinds is not — so the observation carries the kind instead of
 * re-matching the text later. Defined beside the classifier that produces it. */
export type BackendFailureKind =
  | "connection"
  | "timeout"
  | "server"
  | "model-load"
  | "stream-severed";

/** undici's spelling of a severed HTTP stream: the provider (or its own idle timeout) cuts
 * the request while pi is still reading it, and undici's fetch rejects with the bare word
 * "terminated" — the 2026-08-22 idle-timeout diagnosis. Anchored to the END of the error text
 * on purpose: the real message is the bare word, optionally behind a prefix and closing
 * punctuation, while an unrelated error that merely contains the word ("worker terminated
 * with exit code 1") must not read as a backend failure. Exported because the same spelling
 * can arrive on pi's stderr without any pi event for it (src/pi.ts's close handler). */
export const STREAM_SEVERED = /(^|[^a-z])terminated[.!\s]*$/i;

/** The backend-failure error texts pi actually surfaces, matched against every error text
 * feedLine sees — the same shapes as the rate-limit regex's various renderings: pi renders the
 * provider's status and message variously (fetch-level "Connection error.", OpenAI-style
 * "Request timed out" and 5xx status texts, oMLX's model-server "Failed to load model",
 * undici's bare stream-cut "terminated").
 * Deliberately does NOT match the 429 texts: feedLine checks TRANSIENT_RATE_LIMIT first and
 * only falls through here, so a rate limit stays a rate limit (with its Retry-After hint)
 * and never counts as a backend failure. Composed so the stream-severed spelling lives in
 * STREAM_SEVERED alone — src/pi.ts classifies stderr through the same one regex. Only
 * PiStreamParser.feedLine matches the result; backendKind below classifies which phrase
 * matched. */
const TRANSIENT_BACKEND = new RegExp(
  `connection error|connection refused|connection reset|econn(refused|reset)|request timed out|internal server error|bad gateway|service unavailable|gateway timeout|failed to load model|${STREAM_SEVERED.source}`,
  "i",
);

/** Which backend-failure kind an error text belongs to — pure, exported so the parser's
 * classification is unit-testable without a stream (pi-parser.test.ts feeds the texts
 * directly). The order is the TRANSIENT_BACKEND alternation's: one text names one kind. */
export function backendKind(text: string): BackendFailureKind {
  if (/connection error|connection refused|connection reset|econn(refused|reset)/i.test(text)) return "connection";
  if (/request timed out/i.test(text)) return "timeout";
  if (/internal server error|bad gateway|service unavailable|gateway timeout/i.test(text)) return "server";
  if (STREAM_SEVERED.test(text)) return "stream-severed";
  return "model-load";
}

/** Accumulates pi's JSON event stream into a PiRunResult. Exported for tests. */
export class PiStreamParser {
  finalText = "";
  /** True once any assistant message contains the nothing-to-do sentinel, so a
   * declaration in an intermediate turn survives later messages overwriting finalText. */
  declaredNothingToDo = false;
  /** True once any assistant message carries the TUMWATER_REFUSED sentinel — same whole-reply
   * scan as the nothing-to-do sentinel (a refusal declared in an intermediate turn must
   * survive later closing remarks). */
  refused = false;
  /** The one-line reason from the FIRST parseable TUMWATER_REFUSED line; "" when the sentinel
   * appeared bare or no message carried a reason. */
  refusedReason = "";
  /** Text of the LAST assistant message carrying a parseable VERDICT line (the review gate's
   * reply contract) — scanned across every message like the sentinel, so a verdict emitted in
   * an intermediate turn survives later closing remarks overwriting finalText. */
  verdictText = "";
  /** Assistant turns completed (message_end events) — feeds PiRunResult.turns, which the
   * commit trailer and the high-friction flag read. */
  turns = 0;
  /** Tokens the model actually generated (usage.output summed across turns). */
  outputTokens = 0;
  /** Largest single-request context seen (usage.totalTokens is the request's whole
   * context, so summing it across turns hugely overstates real consumption). */
  peakContextTokens = 0;
  costUsd = 0;
  stopReason: string | undefined;
  errorMessage: string | undefined;
  /** True when any event reports the provider rejecting the context as too large
   * (LM Studio's "Context size has been exceeded"; oMLX rejects over max_context_window).
   * Diagnostic: every tick starts a fresh session, so nothing needs dropping — but the
   * error names the real cause. */
  contextExceeded = false;
  /** True when any event reports the model server killing an idle predict stream
   * (LM Studio's "Engine protocol predict stream timed out", e.g. after OS sleep).
   * Transient: the session is healthy and a fresh attempt usually succeeds. Retained as a
   * guard after the move to oMLX, which has not been seen to emit this. */
  transientServerTimeout = false;
  /** True when any event reports the provider rejecting the request with HTTP 429 (rate
   * limiting). Transient by definition: the session is healthy and a later attempt succeeds —
   * the loop's transient retry covers it, waiting out retryAfterSeconds when present. */
  transientRateLimit = false;
  /** True when any event reports a provider-wide failure that is not rate limiting — the
   * connection down, a 5xx, the model failing to load (TRANSIENT_BACKEND above). Transient in
   * the same sense: the session is healthy and a later attempt succeeds. The fleet-wide hold
   * (src/fleet-hold.ts) consumes it beside the 429 flag, grouped by backendFailureKind. */
  transientBackend = false;
  /** Which kind of backend failure the run saw (backendKind's classification of the same
   * text that set transientBackend) — carried so the hold's storm test can group by kind
   * without re-matching the text. Undefined while transientBackend is false. */
  backendFailureKind: BackendFailureKind | undefined;
  /** The Retry-After delay (seconds) from the rate-limit error text, when the provider sent
   * one. Undefined when the error carried no parseable hint. */
  retryAfterSeconds: number | undefined;
  /** True when the run's LAST assistant message carried no text and no tool call
   * (thinking-only or empty). A compliant finish always ends with a text block (the
   * SUMMARY/sentinel line), so this signals a generation cut off mid-stream — typically
   * pi clamping max output tokens to the sliver left under the declared context window,
   * with the provider misreporting the truncation as a normal stop — LM Studio's
   * /v1/responses reported status "completed" instead of "incomplete". **oMLX reports this
   * correctly** (chat/completions finish_reason "length"; /v1/responses status "incomplete"
   * with incomplete_details.reason "max_output_tokens"), so on the current backend a
   * contentless final message points at a genuine cut-off, not a misreported stop. */
  finalMessageContentless = false;
  /** True when pi auto-compacted the session during (or at the end of) the run. */
  compacted = false;
  /** Incremented for every parsed event that represents real forward progress — message,
   * turn, and tool boundaries, retries, session events. Streaming deltas (message_update)
   * never count: pi's JSON protocol strips the cumulative snapshot from them, so they carry
   * nothing this parser acts on, and a zombie stream's content-free keepalives (message
   * deltas and content-free tool_execution_updates alike) must not reset the harness's hang
   * watchdog. */
  progressCount = 0;
  /** Tool calls started but not yet ended — pi runs one message's tool calls concurrently by
   * default, so several can be open at once and end in completion order (keyed by pi's
   * toolCallId). `lastActivityAt` moves only on content-bearing updates: bash emits an
   * empty-content update right after start, and a content-free keepalive must not mask a hang.
   * Feeds runPi's stall warning; entries clear at tool_execution_end. */
  openToolCalls: OpenToolCall[] = [];
  private buffer = "";

  /** `onToolCallStart` observes every tool call as it starts, with pi's tool name ("" when pi
   * omitted it) and raw args — a hook for a caller that audits what a run did (the review
   * gate's suite-rerun tripwire, src/suite-rerun.ts) without the parser storing every call of
   * every run. */
  constructor(private readonly onToolCallStart?: (toolName: string, args: unknown) => void) {}

  feed(chunk: string, onLine?: (line: string) => void): void {
    this.buffer += chunk;
    // Scan with an offset instead of slicing the remainder off after every line: each old
    // `slice(nl + 1)` copied everything still unprocessed, so k lines in one chunk cost
    // O(k·L) string copying (measured ~2x on pi's streaming output — a pipe 'data' event can
    // carry hundreds of delta lines). One final slice keeps only the trailing partial line,
    // which by construction holds no newline, so the next feed re-scans exactly what the old
    // per-line slicing left behind.
    let start = 0;
    for (;;) {
      const nl = this.buffer.indexOf("\n", start);
      if (nl < 0) break;
      const line = this.buffer.slice(start, nl);
      start = nl + 1;
      if (!line.trim()) continue;
      onLine?.(line);
      this.feedLine(line);
    }
    if (start > 0) this.buffer = this.buffer.slice(start);
  }

  private feedLine(line: string): void {
    // Streaming deltas are ~72% of log bytes in observed runs, and pi's JSON protocol strips
    // the cumulative message snapshot from them — they carry only constant-size usage plus a
    // small delta event, none of which this parser acts on (progress comes from the boundary
    // events around them). Skip even parsing them.
    if (piEventType(line) === "message_update") return;

    // pi's stream is one JSON object per line: a torn, non-JSON, or valid-JSON-scalar line is
    // noise, not an event — parseJsonObject reads it as no data (the same policy parseEventLine
    // applies to the harness event log and parsePiEventLine applies to pi's log lines) instead
    // of a bare truthy check that would count a stray scalar as forward progress, resetting the
    // hang watchdog for a line that proves nothing.
    const parsed = parseJsonObject(line);
    if (!parsed) return; // Non-JSON noise on stdout; ignore.
    const event = parsed as PiStreamEvent;
    for (const text of [event.errorMessage, event.finalError, event.message?.errorMessage]) {
      if (!text) continue;
      if (CONTEXT_ERROR.test(text)) this.contextExceeded = true;
      // Kept narrow on purpose: a false positive would mask real repeated failures from
      // the session-poisoning heuristic and trigger needless retries.
      if (TRANSIENT_SERVER_TIMEOUT.test(text)) this.transientServerTimeout = true;
      if (TRANSIENT_RATE_LIMIT.test(text)) {
        this.transientRateLimit = true;
        const hint = RETRY_AFTER.exec(text);
        if (hint) this.retryAfterSeconds = Number(hint[1]);
      } else if (TRANSIENT_BACKEND.test(text)) {
        // Rate-limit matched first, so a 429 stays a 429; this branch only sees the
        // connection/5xx/model-load texts the hold groups by kind.
        this.transientBackend = true;
        this.backendFailureKind = backendKind(text);
      }
    }
    // Every structured event (turn/tool/message boundaries, retries, session) is real
    // progress — streaming deltas never are (message_update is skipped above, before
    // parsing), and neither is a content-free tool_execution_update: bash emits one right
    // after start, and a zombie stream's keepalive updates must not reset the hang
    // watchdog any more than a content-free message delta would (the same rule
    // toolUpdateHasContent applies to the stall clock).
    if (!(event.type === "tool_execution_update" && !toolUpdateHasContent(event.partialResult)))
      this.progressCount += 1;
    if (event.type === "compaction_start") this.compacted = true;
    // Open-tool-call tracking for the stall warning: a call that sits open and silent is
    // surfaced by name while the quiet watchdog still counts down. The start/update/end state
    // machine lives in applyToolExecutionEvent, shared with the dashboards' live flag
    // (progress-data.ts); only the label is surface-specific — the warning names the command even
    // when pi omits a toolName, where progress falls back to "tool".
    if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_update" ||
      event.type === "tool_execution_end"
    ) {
      // The full raw command rides the call beside its display label: the stall warning
      // classifies the command's shape (piped or redirected output cannot reach pi live),
      // and describeToolCall's label truncates at 32 chars — an operator past that point
      // would be invisible there.
      const command = toolCallCommand(event.args);
      applyToolExecutionEvent(
        this.openToolCalls,
        event.type,
        event.toolCallId,
        event.partialResult,
        // A nameless call with no recognizable arg still names something — the same "tool"
        // fallback progress-data.ts uses for its stall flag.
        describeToolCall(event.toolName ?? "", event.args) || "tool",
        command,
      );
      if (event.type === "tool_execution_start") this.onToolCallStart?.(event.toolName ?? "", event.args);
    }
    if (event.type !== "message_end" || event.message?.role !== "assistant") return;
    const msg = event.message;
    const text = messageText(msg);
    this.finalMessageContentless = !(msg.content ?? []).some(
      (c) => c.type === "toolCall" || (c.type === "text" && Boolean(c.text?.trim())),
    );
    if (text.trim()) this.finalText = text;
    if (isNothingToDo(text)) this.declaredNothingToDo = true;
    // The refusal comes only from an anchored `TUMWATER_REFUSED: <reason>` line: a bare
    // sentinel and a mid-sentence mention are not refusals, and a negating reason ("none",
    // "(n/a …)") clears one — BUGS.md 2026-09-23, four ticks ended ordinary replies with
    // `TUMWATER_REFUSED: none` and the harness destroyed their tested work. The last anchored
    // line wins (the run's final declaration is its verdict); a message WITHOUT a line leaves
    // an earlier declaration standing, so a closing remark cannot erase it.
    const refusal = extractRefusal(text);
    if (refusal !== null) {
      if (isNegatedRefusal(refusal)) {
        this.refused = false;
        this.refusedReason = "";
      } else {
        this.refused = true;
        this.refusedReason = refusal;
      }
    }
    if (hasVerdictLine(text)) this.verdictText = text;
    this.turns += 1;
    this.outputTokens += msg.usage?.output ?? 0;
    this.peakContextTokens = Math.max(this.peakContextTokens, msg.usage?.totalTokens ?? 0);
    this.costUsd += msg.usage?.cost?.total ?? 0;
    this.stopReason = msg.stopReason;
    if (msg.errorMessage) this.errorMessage = msg.errorMessage;
    else if (msg.stopReason !== "error") this.errorMessage = undefined;
  }
}
