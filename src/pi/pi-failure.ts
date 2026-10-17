/** The backend-failure classifier for the pi seam: given provider/pi error text, decide
 * whether it names a permanent configuration error or a transient backend failure, and which
 * `BackendFailureKind` it is. This vocabulary is cross-cutting — the settle/team hold groups a
 * storm by kind (src/team/team-hold.ts), the merge path pins a permanent config error, the pi
 * adapter's stderr path (src/pi/pi-backend.ts) and the stream parser both classify — so it
 * lives in its own module instead of hiding inside the stream parser (which used to be its
 * only home: pi-backend.ts had to import a parser to get a classifier). Keep the per-kind
 * regexes here so the transient gate and the kind classifier cannot disagree: they compose one
 * `TRANSIENT_BACKEND` alternation and `backendKind` orders its checks the same way.
 *
 * The parser-local error heuristics that feed PiStreamParser's own flags — the context-overflow,
 * predict-stream-timeout, and rate-limit+Retry-After patterns — stay in src/pi/pi-stream.ts:
 * they are stream-parsing concerns (they drive `contextExceeded`/`transientServerTimeout`/
 * `transientRateLimit`), not the cross-module "what kind of failure is this" vocabulary. */
const PERMANENT_CONFIG_ERROR = /\b(?:400|401|403|404)\b|model_not_supported|invalid_request_error/i;

/** True when an error text names a permanent provider configuration error (see
 * PERMANENT_CONFIG_ERROR). Pure, exported so the merge path and the stderr path classify
 * with one rule. */
export function isPermanentConfigError(text: string): boolean {
  return PERMANENT_CONFIG_ERROR.test(text);
}

/** The kinds of provider-wide failure that are NOT rate limiting: the backend itself is down,
 * refusing connections, or cannot serve the model at all. The team-wide hold (src/
 * team/team-hold.ts) groups a storm by kind — two roles hitting the same kind is one storm,
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
 * with exit code 1") must not read as a backend failure. Module-private: matchBackendFailure
 * below, the parser, and backendKind all share the one instance. */
const STREAM_SEVERED = /(^|[^a-z])terminated[.!\s]*$/i;

/** The connection-class backend-failure phrases: fetch-level "Connection error.", the
 * refusals and resets Node surfaces. One home shared by the TRANSIENT_BACKEND gate and the
 * backendKind classifier, so a spelling added to one cannot go missing from the other. */
const CONNECTION_ERROR = /connection error|connection refused|connection reset|econn(refused|reset)/i;

/** The timeout-class backend-failure phrase (OpenAI-style "Request timed out"). Shared by the
 * TRANSIENT_BACKEND gate and the backendKind classifier. */
const TIMEOUT_ERROR = /request timed out/i;

/** The server-class backend-failure phrases: 5xx status texts, oMLX's model-server pause, and
 * a provider pausing itself team-wide with a 503 whose body carries prose rather than any
 * status phrase ("Provider '<name>' is currently failing for model '<id>' and has been paused
 * by the provider"). Shared by the TRANSIENT_BACKEND gate and the backendKind classifier. */
const SERVER_ERROR = /internal server error|bad gateway|service unavailable|gateway timeout|currently failing for model|paused by the provider/i;

/** The model-load spelling (oMLX's "Failed to load model"): its backendKind is the
 * "model-load" default, so only the gate names the pattern. */
const MODEL_LOAD_ERROR = /failed to load model/i;

/** The backend-failure error texts pi actually surfaces, matched against every error text
 * feedLine sees — the same shapes as the rate-limit regex's various renderings.
 * Deliberately does NOT match the 429 texts: feedLine checks TRANSIENT_RATE_LIMIT first and
 * only falls through here, so a rate limit stays a rate limit (with its Retry-After hint)
 * and never counts as a backend failure. Composed from the per-kind patterns above so each
 * kind's spellings — including the stream-severed one (STREAM_SEVERED) — live in exactly one
 * place. Only matchBackendFailure and PiStreamParser.feedLine match it; backendKind below
 * classifies which phrase matched. */
export const TRANSIENT_BACKEND = new RegExp(
  `${CONNECTION_ERROR.source}|${TIMEOUT_ERROR.source}|${SERVER_ERROR.source}|${MODEL_LOAD_ERROR.source}|${STREAM_SEVERED.source}`,
  "i",
);

/** Which backend-failure kind an error text belongs to — pure, exported so the parser's
 * classification is unit-testable without a stream (pi-parser.test.ts feeds the texts
 * directly). Each check is the same per-kind pattern the TRANSIENT_BACKEND gate composes, so
 * the gate and the classifier cannot disagree; the order matches that alternation. */
export function backendKind(text: string): BackendFailureKind {
  if (CONNECTION_ERROR.test(text)) return "connection";
  if (TIMEOUT_ERROR.test(text)) return "timeout";
  if (SERVER_ERROR.test(text)) return "server";
  if (STREAM_SEVERED.test(text)) return "stream-severed";
  return "model-load";
}

/** The backend-failure kind `text` names, or undefined when it names none — the stderr
 * classifier (src/pi/pi-backend.ts's classifyExit) needs "no match" distinct from
 * backendKind's "model-load" default. Gated by TRANSIENT_BACKEND, so a text the event path
 * ignores is ignored on stderr too. Pure; exported for pi-backend.ts's classifyExit. */
export function matchBackendFailure(text: string): BackendFailureKind | undefined {
  return TRANSIENT_BACKEND.test(text) ? backendKind(text) : undefined;
}

/** The valid `backendKind` values, for validating a translator-supplied string at the wire
 * boundary (the same untrusted-JSON policy every other field read here applies). */
const BACKEND_FAILURE_KINDS: readonly BackendFailureKind[] = [
  "connection",
  "timeout",
  "server",
  "model-load",
  "stream-severed",
];

export function isBackendFailureKind(value: unknown): value is BackendFailureKind {
  return typeof value === "string" && (BACKEND_FAILURE_KINDS as readonly string[]).includes(value);
}
