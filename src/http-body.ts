/**
 * The dashboard's shared HTTP response/body plumbing: sendJson (every /api endpoint answers
 * through it), the request-body cap, the chunked reader that enforces it, and readJsonObject
 * (the shared front half of every /api POST handler). Extracted from gui/gui-endpoints.ts so the
 * handlers there (and, since the POST operators moved to gui/gui-endpoint-commands.ts, those too)
 * read as endpoint logic alone — the streaming internals and the buffered-bytes
 * counter live here, one layer down from any single endpoint. Server lifecycle, routing, the
 * static page, and the token gate stay in gui/gui-server.ts.
 */
import type http from "node:http";
import { parseJsonObject } from "./json-object.js";
import { errorMessage } from "./text/text.js";

/** Send a JSON response with the given status code and body. Every /api endpoint answers
 * this way (errors included), so the content-type header lives in exactly one place. */
export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Max request body for the /api POST endpoints, in wire bytes. Sized for the prompt
 * endpoints' image attachments: 4 images × 5 MiB × 4/3 base64 expansion ≈ 27 MiB must fit one
 * POST, with headroom — the cap exists to bound memory on a local dashboard, not to be tight.
 * Over it the promise rejects ("body too large: ... over the N byte (32 MiB) cap", naming both
 * the cap and the rejected size) and buffering STOPS — later chunks are drained and discarded,
 * so a client that keeps uploading after the cap cannot grow the buffer past ~one chunk over
 * the limit. Without the stop, every late chunk was still appended to the body long after the
 * rejection: an unbounded allocation on a network-facing endpoint. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Wire bytes readBody is holding right now, across all in-flight requests. Deliberately
 * observable (bufferedBodyBytes below hands it to tests): the oversized-body guarantee
 * ("buffering stops at the cap, the buffer is released at rejection") is a statement about
 * exactly these bytes, so the regression test reads this instead of a whole-process heap
 * delta — heap counts garbage and unrelated allocations too, so host noise can flip such a
 * measurement either way. The counter rises only while a request is still under the cap, is
 * zeroed the moment a request settles, and can therefore never exceed the cap plus one
 * chunk. */
let inFlightBufferedBytes = 0;

/** inFlightBufferedBytes, exposed for the oversized-body regression test's assertions — the
 * counter above carries the rationale for why it is these bytes and not a heap delta. */
export function bufferedBodyBytes(): number {
  return inFlightBufferedBytes;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    // Accumulate raw bytes and decode ONCE at the end. Chunk boundaries are arbitrary TCP
    // framing, so a multi-byte UTF-8 character can straddle two chunks — decoding each chunk
    // independently would replace every split byte with U+FFFD, silently corrupting the prompt
    // (one 3-byte character split in two becomes three replacement characters).
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let bufferedNow = 0; // this request's contribution to inFlightBufferedBytes
    const releaseBuffer = (): void => {
      inFlightBufferedBytes -= bufferedNow;
      bufferedNow = 0;
    };
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    function onData(chunk: Buffer): void {
      if (settled) return; // over the cap: discard — only memory would grow
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        settled = true;
        chunks.length = 0; // release what we kept before rejecting
        releaseBuffer();
        cleanup();
        req.resume(); // keep draining so the upload can finish and the socket closes cleanly
        // Name the offending value and the fix, like every sibling error: the operator
        // pasting an oversized prompt into the dashboard sees how far over they are
        // instead of an unquantified "body too large".
        reject(
          new Error(
            `body too large: request is ${bytes} bytes, over the ${MAX_BODY_BYTES} byte (${MAX_BODY_BYTES / (1024 * 1024)} MiB) cap`,
          ),
        );
        return;
      }
      chunks.push(chunk);
      bufferedNow += chunk.length;
      inFlightBufferedBytes += chunk.length;
    }
    function onEnd(): void {
      if (settled) return;
      settled = true;
      const body = Buffer.concat(chunks).toString("utf8");
      cleanup();
      releaseBuffer();
      resolve(body);
    }
    function onError(err: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      releaseBuffer();
      reject(err);
    }
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/** Read a POST body as a JSON object — the shared front half of every /api POST handler:
 * oversized bodies get 413, malformed or non-object bodies get 400 with `example` showing
 * the expected shape (client-side failures get an actionable message, not a 500 carrying
 * Node's raw SyntaxError/TypeError, which misreports the fault and hides the fix), and the
 * parsed object is returned — null once any 4xx was sent. */
export async function readJsonObject(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  example: string,
): Promise<Record<string, unknown> | null> {
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    sendJson(res, 413, { error: errorMessage(err) }); // body too large: ... over the ... cap
    return null;
  }
  // Malformed JSON and valid JSON that is not an object ("just a string", [1], null) get
  // the same fix as each other — pointing at a field of a body that has none would mislead
  // — so json-object.ts's one parse-or-no-data policy (parseJsonObject) is exactly the
  // shape this check needs; only the oversized-body read above keeps its own try/catch,
  // because it sends a different status.
  const parsed = parseJsonObject(body);
  if (!parsed) {
    sendJson(res, 400, { error: `body must be a JSON object like ${example}` });
    return null;
  }
  return parsed;
}
