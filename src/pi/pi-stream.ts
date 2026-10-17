import { extractRefusal, hasVerdictLine, isNegatedRefusal, isNothingToDo } from "../verdict/reply-contract.js";
import {
  applyToolExecutionEvent,
  messageUpdateHasContent,
  piEventType,
  toolCallCommand,
  toolUpdateHasContent,
  type OpenToolCall,
} from "./pi-event-line.js";
import { describeToolCall } from "../text/phrases.js";
import { objectOrEmpty, nonNegativeNumber, parseJsonObject, isJsonObject } from "../files/json-object.js";
import { backendKind, isBackendFailureKind, isPermanentConfigError, TRANSIENT_BACKEND, type BackendFailureKind } from "./pi-failure.js";

/** Accumulating pi's JSON event stream into a run result — pure parsing with no subprocess or
 * file I/O. Split out of pi.ts, whose child-process integration (runPi, hasResumableSession,
 * and the stderr crash signature) now lives in src/agent/run-agent.ts,
 * src/agent/session-ledger.ts, and src/pi/pi-backend.ts — so the parser can be unit-tested and
 * reasoned about without spawning a process, the same separation pi-event-line.ts gives the
 * per-line parse and reply-contract.ts the sentinel/verdict text. */

interface PiMessage {
  role: string;
  // Content blocks cross the provider boundary unvalidated, so `content` is `unknown` and
  // every read goes through messageContent: a non-array `content`, or a non-object entry,
  // reads as no block instead of throwing out of the child's data handler (the same guard
  // transcript.ts's contentBlocks and progress-data.ts's workItemFromContent apply).
  content?: unknown;
  // Usage fields are `unknown`, not `number`: they cross the provider boundary unvalidated,
  // and some OpenAI-compatible servers serialize usage numbers as JSON strings. The fold
  // below runs every value through usageNumber before trusting it.
  usage?: {
    totalTokens?: unknown;
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    cost?: { total?: unknown };
  };
  stopReason?: string;
  errorMessage?: string;
}

/** One wire number from the model server's usage block, or 0 when unusable. Only a finite,
 * non-negative number passes: a string (some OpenAI-compatible servers serialize usage
 * numbers as strings) would turn the `+=` accumulators into string concatenation and then
 * NaN, a negative value would run the spend total backwards, and a non-finite one would
 * poison every consumer — a NaN costUsd makes every budget-cap comparison false, so the
 * daily cap would never trip while the dashboards render "$NaN". Unusable degrades to
 * "ignore this turn's number", the same policy parseJsonObject takes to torn lines. */
function usageNumber(value: unknown): number {
  return nonNegativeNumber(value, 0);
}

/** The classification a backend translator may attach to an error-bearing canonical event,
 * replacing the parser's text regexes with the backend's own explicit signal (plans/
 * agent-backends.md "Canonical event stream"). pi's translator emits none and keeps the
 * regexes; claude's sets one from `api_error_status`/`terminal_reason`. */
export type TumwaterKind =
  | "transientRateLimit"
  | "transientBackend"
  | "configError"
  | "contextExceeded"
  | "budgetCapped"
  | "resumeMissing";

/** One account rate-limit window a run reported (a canonical `rate_limit` event). The
 * subscription usage window (plans/agent-backends.md part 6) collects the newest reading per
 * `type`; the parser carries them so the run result does. */
export interface RateWindow {
  /** `rateLimitType` — `five_hour`, plus any longer window an account reports. */
  type: string;
  /** `allowed` | `allowed_warning` | `rejected`. */
  status: string;
  /** Unix-seconds stamp when the window resets, when reported. */
  resetsAt?: number;
  /** Fraction of the window consumed (0–1), when reported. */
  utilization?: number;
  /** The account's overage state word, when reported. */
  overageStatus?: string;
  /** True while the account is spending into overage. */
  isUsingOverage?: boolean;
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
  /** tool_execution_end events only: the tool's final result (pi serializes the end's result
   * under `result`, distinct from the updates' `partialResult`). The read tool's image/text
   * blocks ride here. */
  result?: unknown;
  /** A translator's explicit classification of an error-bearing event (claude). */
  tumwaterKind?: string;
  /** The transient backend failure kind, when tumwaterKind is `transientBackend`. */
  backendKind?: string;
  retryAfterSeconds?: unknown;
  /** run_cost events only: the run's authoritative cost. */
  total?: unknown;
  /** run_usage events only: the run's authoritative output-token total (claude). */
  outputTokens?: unknown;
  /** run_usage events only: the run's authoritative token split (opencode's export). */
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  /** rate_limit events only, the account-window reading. */
  rateLimitType?: unknown;
  status?: unknown;
  resetsAt?: unknown;
  utilization?: unknown;
  overageStatus?: unknown;
  isUsingOverage?: unknown;
  /** billing events only: `subscription` | `api`. */
  billing?: unknown;
}

/** One content block's fields, each unknown until the consumer guards what it reads. */
interface ContentBlock { type?: unknown; text?: unknown; name?: unknown }

/** The text prefix of a pi `read` result that carries an image (plans/image-input.md
 * "Detecting a blind read"): such a read's text block begins `Read image file [<path>…]`, and
 * pi's non-vision note and its processing-failure notes sit inside that block. A text-only
 * read (a code file) is not phrased this way. */
const IMAGE_READ_PREFIX = "Read image file [";
/** pi's note when the current model does not support images — the blind-read signal: the image
 * is stripped from the request and the agent would answer about a picture it never saw. */
const BLIND_IMAGE_NOTE = "[Current model does not support images";

/** The `path` a read tool call's raw args name, or undefined when they carry none — the read
 * tool opens a file by `path` (with optional `start`/`end` offsets), so the blind read blames
 * the right file. A torn or foreign args object reads as no path (never throws). */
function readPathOf(args: unknown): string | undefined {
  if (!isJsonObject(args)) return undefined;
  return typeof args.path === "string" && args.path ? args.path : undefined;
}

/** The text blocks of one tool-execution end's `result` (the same normalization
 * messageContent applies to a message), or [] when the result is not an object. */
function resultContent(result: unknown): ContentBlock[] {
  if (!isJsonObject(result)) return [];
  return messageContent(result as unknown as PiMessage);
}

/** The content blocks of one pi message, normalized: a `content` that is not an array (torn
 * or foreign wire JSON) reads as no blocks, and a non-object entry reads as an empty block,
 * so the `.filter`/`.some` chains below never throw on a shape the message interface does not
 * promise — the same guard transcript.ts's contentBlocks and progress-data.ts's
 * workItemFromContent apply to the identical field. */
function messageContent(msg: PiMessage): ContentBlock[] {
  if (!Array.isArray(msg.content)) return [];
  return msg.content.map((raw) => (objectOrEmpty(raw)));
}

/** Extract the concatenated text blocks of a pi message. */
function messageText(msg: PiMessage): string {
  return messageContent(msg)
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
 * "later", not the session failing: the team's single largest error source (BUGS.md 2026-09-21)
 * and by definition retryable. Matched against every error text feedLine sees, since pi renders
 * the provider's status and message variously ("429 \"Rate limit exceeded\"", OpenAI's
 * "Too Many Requests"). Retry-After, when the provider echoes it into the error text, is
 * captured in retryAfterSeconds. Module-private: only PiStreamParser.feedLine matches it. */
const TRANSIENT_RATE_LIMIT = /\b429\b|too many requests|rate limit/i;

/** The provider's Retry-After hint inside a rate-limit error text — seconds to wait before
 * retrying. Tolerates the spellings error text actually uses ("Retry-After: 30",
 * "retry after 30s"). Module-private: only PiStreamParser.feedLine matches it. */
const RETRY_AFTER = /retry[- ]after:?\s*(\d{1,4})/i;

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
  /** Prompt tokens this run sent, summed across assistant turns (usage.input + cacheRead +
   * cacheWrite). The counterpart to outputTokens: an operator compares the two to see how
   * much of a tick's spend is re-sent context versus generation. */
  promptTokens = 0;
  /** The cache-read share of promptTokens (usage.cacheRead summed across turns) — the part
   * the provider served from its prompt cache, billed at the cache-read rate. */
  cacheReadTokens = 0;
  /** Prompt tokens sent up to AND INCLUDING the first assistant turn that carried an edit or
   * write tool call. Before any such turn every turn accumulates; once one is seen the
   * counter freezes, so it measures the context a tick burns before its first change. */
  preEditPromptTokens = 0;
  /** 1-based index of the first assistant turn carrying an edit or write tool call;
   * undefined when the run never edited. */
  firstEditTurn: number | undefined;
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
   * connection down, a 5xx, the model failing to load (TRANSIENT_BACKEND, in pi-failure.ts).
   * Transient in the same sense: the session is healthy and a later attempt succeeds. The
   * team-wide hold (src/team/team-hold.ts) consumes it beside the 429 flag, grouped by
   * backendFailureKind. */
  transientBackend = false;
  /** Which kind of backend failure the run saw (backendKind's classification of the same
   * text that set transientBackend) — carried so the hold's storm test can group by kind
   * without re-matching the text. Undefined while transientBackend is false. */
  backendFailureKind: BackendFailureKind | undefined;
  /** The Retry-After delay (seconds) from the rate-limit error text, when the provider sent
   * one. Undefined when the error carried no parseable hint. */
  retryAfterSeconds: number | undefined;
  /** True when any error text names a permanent provider configuration error (a 4xx other
   * than 408/429, or the provider's model_not_supported/invalid_request_error spelling): the
   * request can never succeed until the config changes, so the merge path holds the pin
   * rather than re-queuing it at suite speed (BUGS.md 2026-10-06). Matched only when the text
   * did not match rate-limit or a transient backend pattern first. */
  configError = false;
  /** True when a translator classified the run's error as a per-run budget cap
   * (`error_max_budget_usd`, plans/agent-backends.md part 7). claude-only; pi never sets it. */
  budgetCapped = false;
  /** True when a translator classified the run as resuming a session its backend cannot find
   * (`No conversation found with session ID`) — the caller retries fresh (plans/agent-backends.md
   * part 3c). claude-only; pi never sets it. */
  resumeMissing = false;
  /** How the run was paid for, from a canonical `billing` event (claude's `system/init`
   * `apiKeySource`): a `subscription` window or API credit. Undefined when the backend
   * reported neither. */
  billing: "subscription" | "api" | undefined;
  /** The newest account rate-limit reading per `rateLimitType` (plans/agent-backends.md part 6),
   * in first-seen order of the type. Empty on backends that report no windows. */
  rateWindows: RateWindow[] = [];
  /** True when any rate-limit reading reported the account spending into overage. */
  usedOverage = false;
  /** The one `read` tool call this run made on an image the model cannot see (plans/
   * image-input.md "Detecting a blind read"): the image path and the seam's effective image
   * input are reported at once, so the runner can kill an authoring run instead of letting
   * the agent answer about a picture it never saw. The FIRST blind read wins — later ones
   * add nothing. */
  imageBlind: { path: string } | undefined;
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
  /** True once any assistant message carried real content — a tool call or non-empty text.
   * A failed run whose every assistant turn is contentless (the provider's error turn has
   * `content: []` and stopReason "error") produced no work of its own, so a dirty worktree
   * belongs to a prior interrupted tick rather than this run (BUGS.md 2026-10-06). Distinct
   * from finalMessageContentless, which describes only the LAST message. */
  producedAssistantContent = false;
  /** True when pi auto-compacted the session during (or at the end of) the run. */
  compacted = false;
  /** Incremented for every parsed event that represents real forward progress — message,
   * turn, and tool boundaries, retries, session events, and content-bearing updates
   * (message_update deltas and tool_execution_updates alike). A content-free keepalive never
   * counts: a zombie stream's periodic empty updates must not reset the harness's hang
   * watchdog. */
  progressCount = 0;
  /** Tool calls started but not yet ended — pi runs one message's tool calls concurrently by
   * default, so several can be open at once and end in completion order (keyed by pi's
   * toolCallId). `lastActivityAt` moves only on content-bearing updates: bash emits an
   * empty-content update right after start, and a content-free keepalive must not mask a hang.
   * Feeds runPi's stall warning; entries clear at tool_execution_end. */
  openToolCalls: OpenToolCall[] = [];
  /** Read tool calls started but not yet ended, keyed by pi's toolCallId so concurrent reads
   * attribute their end to the right start (pi runs one message's tool calls concurrently, so
   * several can be open at once and end in completion order — the same rule
   * openToolCalls tracks). The value is the call's `args.path`, captured at start so the
   * result on end has a path to blame when the read was blind. */
  private readonly readPaths = new Map<string, string>();
  private buffer = "";

  /** `onToolCallStart` observes every tool call as it starts, with pi's tool name ("" when pi
   * omitted it) and raw args — a hook for a caller that audits what a run did (the review
   * gate's suite-rerun tripwire, src/review/suite-rerun.ts) without the parser storing every
   * call of every run. */
  constructor(
    private readonly onToolCallStart?: (toolName: string, args: unknown) => void,
    private readonly image: {
      /** The seam's effective image input (plans/image-input.md "Detecting a blind read"): a
       * text-only seam makes every image read blind even when pi adds no note (a claim its
       * doctor probe proved false), while `null` (unknown, or reads images) leaves the pi note
       * the only blind signal. */
      imageInput?: boolean | null;
      /** Called once, at the FIRST blind read, with its path — the runner's hook to kill an
       * authoring run at once (src/agent/run-agent.ts) before the agent goes on working from
       * a picture it never saw. */
      onBlindRead?: (path: string) => void;
    } = {},
  ) {}

  /** Apply a translator-supplied `tumwaterKind`, trusted before the text regexes. An unknown
   * kind is ignored (the same forward-compatible policy as an unknown event type). */
  private applyTumwaterKind(kind: string, event: PiStreamEvent): void {
    switch (kind) {
      case "transientRateLimit":
        this.transientRateLimit = true;
        this.setRetryAfterSeconds(event.retryAfterSeconds);
        break;
      case "transientBackend":
        this.transientBackend = true;
        this.backendFailureKind = isBackendFailureKind(event.backendKind) ? event.backendKind : "server";
        break;
      case "configError":
        this.configError = true;
        break;
      case "contextExceeded":
        this.contextExceeded = true;
        break;
      case "budgetCapped":
        this.budgetCapped = true;
        break;
      case "resumeMissing":
        this.resumeMissing = true;
        break;
      default:
        break;
    }
  }

  /** Fold one canonical `rate_limit` reading: keep the newest per type, note overage, and
   * treat a `rejected` window as the transient rate limit it is (with the resetsAt-derived
   * wait the translator attached). */
  private applyRateLimit(event: PiStreamEvent): void {
    const type = typeof event.rateLimitType === "string" && event.rateLimitType ? event.rateLimitType : "unknown";
    const reading: RateWindow = { type, status: typeof event.status === "string" ? event.status : "" };
    if (typeof event.resetsAt === "number" && Number.isFinite(event.resetsAt)) reading.resetsAt = event.resetsAt;
    if (typeof event.utilization === "number" && Number.isFinite(event.utilization))
      reading.utilization = event.utilization;
    if (typeof event.overageStatus === "string") reading.overageStatus = event.overageStatus;
    if (event.isUsingOverage === true) reading.isUsingOverage = true;
    const existing = this.rateWindows.findIndex((w) => w.type === type);
    // A reading without a status (a non-binding window's utilization) keeps the last known one.
    if (reading.status === "" && existing >= 0) reading.status = this.rateWindows[existing]?.status ?? "";
    if (existing >= 0) this.rateWindows[existing] = reading;
    else this.rateWindows.push(reading);
    if (reading.isUsingOverage === true) this.usedOverage = true;
    if (reading.status === "rejected") {
      this.transientRateLimit = true;
      this.setRetryAfterSeconds(event.retryAfterSeconds);
    }
  }

  /** Fold a provider Retry-After hint into `retryAfterSeconds`: ignore a non-number or
   * non-finite value, and clamp a negative or fractional one to whole seconds. */
  private setRetryAfterSeconds(value: unknown): void {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    this.retryAfterSeconds = Math.max(0, Math.round(value));
  }

  /** Decide whether one finished `read` call returned an image the model cannot see, and if so
   * record the FIRST such read and fire the `onBlindRead` hook (plans/image-input.md
   * "Detecting a blind read"). An image read is a result whose content holds an `image` block,
   * or a text block starting `Read image file [`; it is blind when that text carries pi's
   * non-vision note, or when the runner told us the seam's effective image input is false —
   * the second arm catches a claim doctor's probe proved false, where pi sends the image and
   * adds no note. pi's processing-failure notes (`[Image omitted: could not be converted…]` /
   * `…resized…`) are NOT blind on a vision-capable model: they name a conversion/file problem,
   * not a capability gap (a non-vision model's read carries its own note, which IS blind). */
  private detectBlindRead(path: string, result: unknown): void {
    if (this.imageBlind) return; // the first blind read is the one that stops the run
    const blocks = resultContent(result);
    const isImageRead =
      blocks.some((c) => c.type === "image") ||
      blocks.some((c) => typeof c.text === "string" && c.text.startsWith(IMAGE_READ_PREFIX));
    if (!isImageRead) return;
    const text = blocks
      .filter((c) => typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
    const blind = text.includes(BLIND_IMAGE_NOTE) || this.image.imageInput === false;
    if (!blind) return;
    this.imageBlind = { path };
    this.image.onBlindRead?.(path);
  }

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
    // Streaming deltas are ~72% of log bytes in observed runs. pi's JSON protocol strips the
    // cumulative message snapshot from them, so the delta event is all they carry — and a
    // content-free one (a zombie stream's keepalive, or the pre-strip shape) proves nothing:
    // it must not reset the hang watchdog. A content-bearing delta is real generation, and
    // counting it is what keeps a long thinking block on a slow model from being quiet-killed
    // as hung (BUGS.md 2026-10-17) — the same content rule tool_execution_update gets below.
    // Nothing else in this parser acts on the type, so the line is done either way.
    if (piEventType(line) === "message_update") {
      if (messageUpdateHasContent(parseJsonObject(line))) this.progressCount += 1;
      return;
    }

    // pi's stream is one JSON object per line: a torn, non-JSON, or valid-JSON-scalar line is
    // noise, not an event — parseJsonObject reads it as no data (the same policy parseEventLine
    // applies to the harness event log and parsePiEventLine applies to pi's log lines) instead
    // of a bare truthy check that would count a stray scalar as forward progress, resetting the
    // hang watchdog for a line that proves nothing.
    const parsed = parseJsonObject(line);
    if (!parsed) return; // Non-JSON noise on stdout; ignore.
    const event = parsed as PiStreamEvent;
    // A translator-classified error (claude's `tumwaterKind`) is trusted before the text
    // regexes: the backend read schemas, not prose, and its signal wins.
    if (typeof event.tumwaterKind === "string" && event.tumwaterKind) {
      this.applyTumwaterKind(event.tumwaterKind, event);
    } else {
      for (const text of [event.errorMessage, event.finalError, event.message?.errorMessage]) {
        if (!text) continue;
        if (CONTEXT_ERROR.test(text)) this.contextExceeded = true;
        // Kept narrow on purpose: a false positive would mask real repeated failures from
        // the session-poisoning heuristic and trigger needless retries.
        if (TRANSIENT_SERVER_TIMEOUT.test(text)) this.transientServerTimeout = true;
        if (TRANSIENT_RATE_LIMIT.test(text)) {
          this.transientRateLimit = true;
          const hint = RETRY_AFTER.exec(text);
          if (hint) this.setRetryAfterSeconds(Number(hint[1]));
        } else if (TRANSIENT_BACKEND.test(text)) {
          // Rate-limit matched first, so a 429 stays a 429; this branch only sees the
          // connection/5xx/model-load texts the hold groups by kind.
          this.transientBackend = true;
          this.backendFailureKind = backendKind(text);
        } else if (isPermanentConfigError(text)) {
          // A permanent 4xx config error: transient checks had their turn first, so 408/429
          // never land here.
          this.configError = true;
        }
      }
    }
    // A canonical run_cost is the run's authoritative cost and REPLACES the per-message sum
    // (claude's split-block messages report cost.total 0; the final result carries the real
    // number). A backend that emits none keeps the summed per-message figure (pi).
    if (event.type === "run_cost") this.costUsd = usageNumber(event.total);
    // Likewise a run_usage replaces the summed per-message token figures (claude's per-message
    // usage is the stream-start snapshot, about 8x low). OpenCode's export drives a run_usage
    // that carries the run's whole token split — input, output, cacheRead, cacheWrite — and
    // replaces all four summed fields, the way run_cost replaces the cost sum; a stream without
    // one keeps its summed figures. A run_usage bearing only outputTokens (claude) keeps the
    // historical behavior of replacing just the output sum. The split's sum is a cumulative RUN
    // total, not a single request, so it never touches peakContextTokens (a per-request peak
    // the stream keeps computing); the export carries no total and none is invented here.
    if (event.type === "run_usage") {
      if (event.input !== undefined || event.cacheRead !== undefined || event.cacheWrite !== undefined) {
        const input = usageNumber(event.input);
        const cacheRead = usageNumber(event.cacheRead);
        const cacheWrite = usageNumber(event.cacheWrite);
        const output = usageNumber(event.output);
        this.outputTokens = output;
        this.promptTokens = input + cacheRead + cacheWrite;
        this.cacheReadTokens = cacheRead;
      } else {
        this.outputTokens = usageNumber(event.outputTokens);
      }
    }
    // A canonical rate_limit event carries an account-window reading: collect the newest per
    // type, note any overage, and treat a rejected window as the transient rate limit it is.
    if (event.type === "rate_limit") this.applyRateLimit(event);
    if (event.type === "billing" && (event.billing === "subscription" || event.billing === "api"))
      this.billing = event.billing;
    // Every structured event (turn/tool/message boundaries, retries, session) is real
    // progress, and so is a content-bearing update — but a content-free one never is: bash
    // emits an empty tool_execution_update right after start, and a zombie stream's keepalive
    // updates must not reset the hang watchdog any more than a content-free message delta
    // would (message_update deltas are counted above, before this point, by the same rule).
    if (!(event.type === "tool_execution_update" && !toolUpdateHasContent(event.partialResult)))
      this.progressCount += 1;
    if (event.type === "compaction_start") this.compacted = true;
    // Open-tool-call tracking for the stall warning: a call that sits open and silent is
    // surfaced by name while the quiet watchdog still counts down. The start/update/end state
    // machine lives in applyToolExecutionEvent, shared with the dashboards' live flag
    // (src/ui/progress-data.ts); only the label is surface-specific — the warning names the
    // command even when pi omits a toolName, where progress falls back to "tool".
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
        // fallback src/ui/progress-data.ts uses for its stall flag.
        describeToolCall(event.toolName ?? "", event.args) || "tool",
        command,
      );
      if (event.type === "tool_execution_start") this.onToolCallStart?.(event.toolName ?? "", event.args);
      // The blind-read detector (plans/image-input.md "Detecting a blind read"): remember
      // each read call's path from its start, and on its end decide whether the image it
      // returned was one the model cannot see — so the runner can kill an authoring run
      // instead of letting the agent answer about a picture it never saw.
      if (event.type === "tool_execution_start" && event.toolName === "read") {
        const p = readPathOf(event.args);
        if (p !== undefined) this.readPaths.set(String(event.toolCallId), p);
      } else if (event.type === "tool_execution_end") {
        const id = String(event.toolCallId);
        const p = this.readPaths.get(id);
        if (p !== undefined) {
          this.readPaths.delete(id);
          this.detectBlindRead(p, event.result);
        }
      }
    }
    if (event.type !== "message_end" || event.message?.role !== "assistant") return;
    const msg = event.message;
    const text = messageText(msg);
    this.finalMessageContentless = !messageContent(msg).some(
      (c) =>
        c.type === "toolCall" ||
        (c.type === "text" && typeof c.text === "string" && Boolean(c.text.trim())),
    );
    if (!this.finalMessageContentless) this.producedAssistantContent = true;
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
    this.outputTokens += usageNumber(msg.usage?.output);
    const promptTokens = usageNumber(msg.usage?.input) + usageNumber(msg.usage?.cacheRead) + usageNumber(msg.usage?.cacheWrite);
    this.promptTokens += promptTokens;
    this.cacheReadTokens += usageNumber(msg.usage?.cacheRead);
    // The pre-edit prefix: accumulate every turn until one carries an edit/write tool call,
    // including that turn's own prompt (it was sent before the edit happened). Once seen,
    // firstEditTurn pins the count and later turns stop adding.
    if (this.firstEditTurn === undefined) {
      this.preEditPromptTokens += promptTokens;
      if (messageContent(msg).some((c) => c.type === "toolCall" && (c.name === "edit" || c.name === "write")))
        this.firstEditTurn = this.turns;
    }
    this.peakContextTokens = Math.max(this.peakContextTokens, usageNumber(msg.usage?.totalTokens));
    this.costUsd += usageNumber(msg.usage?.cost?.total);
    this.stopReason = msg.stopReason;
    if (msg.errorMessage) this.errorMessage = msg.errorMessage;
    else if (msg.stopReason !== "error") this.errorMessage = undefined;
  }
}
