import http from "node:http";
import os from "node:os";
import {
  type BacklogEntry,
  openBugEntries,
  openQuestionEntries,
  plannedPlanEntries,
} from "../backlog.js";
import { parseNonNegativeInt, parsePositiveInt } from "../cli-args.js";
import { submitPrompt } from "../inbox.js";
import { GUI_PAGE } from "./gui-page.js";
import { allRoleIds } from "../roles.js";
import { statusPayload } from "./status-payload.js";
import { readTranscript } from "./transcript.js";
import { errorMessage } from "../text.js";

/** Send a JSON response with the given status code and body. Every /api endpoint answers
 * this way (errors included), so the content-type header lives in exactly one place. */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Handle GET /api/transcript?role=<id>&n=N: rendered transcript lines for one loop's pi
 * log (same rendering as `tumwater logs --role <id>`). Unknown/missing role or a bad n → 400. */
function handleTranscript(req: http.IncomingMessage, res: http.ServerResponse, root: string): void {
  const q = new URL(req.url ?? "", "http://localhost").searchParams;
  const role = q.get("role");
  if (!role || !allRoleIds().includes(role)) {
    sendJson(res, 400, { error: `unknown or missing role (valid ids: ${allRoleIds().join(", ")})` });
    return;
  }
  let n = 50;
  const nRaw = q.get("n");
  if (nRaw !== null) {
    const parsed = parsePositiveInt(nRaw);
    if (parsed === null) {
      sendJson(res, 400, { error: `n must be a positive integer (got ${JSON.stringify(nRaw)})` });
      return;
    }
    n = parsed;
  }
  sendJson(res, 200, { lines: readTranscript(root, role, n) });
}

/** Handle GET /api/backlog?file=<plans|bugs|questions>&index=N: one backlog entry's full
 * text ({title, body}), fetched on demand so multi-KB bodies (long repros, whole plans) never
 * ride the 1-second /api/status poll. index addresses the Nth entry of that file's open
 * section in the same order statusPayload lists its titles — PLANS.md ## Planned,
 * BUGS.md ## Open, QUESTIONS.md ## Open — zero-based. Unknown/missing file, missing or bad
 * index, and out-of-range index → 400 JSON error via sendJson. */
function handleBacklog(req: http.IncomingMessage, res: http.ServerResponse, root: string): void {
  const q = new URL(req.url ?? "", "http://localhost").searchParams;
  const file = q.get("file");
  let entries: BacklogEntry[] | null = null;
  if (file === "plans") entries = plannedPlanEntries(root);
  else if (file === "bugs") entries = openBugEntries(root);
  else if (file === "questions") entries = openQuestionEntries(root);
  if (!entries) {
    sendJson(res, 400, { error: `unknown or missing file (valid values: plans, bugs, questions)` });
    return;
  }
  const indexRaw = q.get("index");
  if (indexRaw === null) {
    sendJson(res, 400, { error: "index required" });
    return;
  }
  const index = parseNonNegativeInt(indexRaw);
  if (index === null) {
    sendJson(res, 400, { error: `index must be a non-negative integer (got ${JSON.stringify(indexRaw)})` });
    return;
  }
  const entry = entries[index];
  if (!entry) {
    sendJson(res, 400, { error: `index out of range (${entries.length} ${file})` });
    return;
  }
  sendJson(res, 200, { title: entry.title, body: entry.body });
}

/** Max request body for /api/prompt, in wire bytes. Over it the promise rejects
 * ("body too large") and buffering STOPS — later chunks are drained and discarded, so a client
 * that keeps uploading after the cap cannot grow the buffer past ~one chunk over the limit.
 * Without the stop, every late chunk was still appended to the body long after the rejection:
 * an unbounded allocation on a network-facing endpoint. */
const MAX_BODY_BYTES = 64 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    // Accumulate raw bytes and decode ONCE at the end. Chunk boundaries are arbitrary TCP
    // framing, so a multi-byte UTF-8 character can straddle two chunks — decoding each chunk
    // independently would replace every split byte with U+FFFD, silently corrupting the prompt
    // (one 3-byte character split in two becomes three replacement characters).
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
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
        cleanup();
        req.resume(); // keep draining so the upload can finish and the socket closes cleanly
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    }
    function onEnd(): void {
      if (settled) return;
      settled = true;
      const body = Buffer.concat(chunks).toString("utf8");
      cleanup();
      resolve(body);
    }
    function onError(err: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/** External IPv4 addresses of this machine's network interfaces, for printing the URLs a
 * `gui --all-interfaces` server is reachable at. IPv6 and internal (loopback) addresses are
 * skipped: the loopback URL is printed separately, and bracketed IPv6 URLs are rarely what
 * someone types on another device. The interface table is injectable (defaulting to the live
 * one) so the filter's inclusions and exclusions stay unit-testable on machines — CI boxes,
 * containers — that have no external address of their own. The parameter type says what
 * os.networkInterfaces() really returns: an interface with no addresses maps to undefined,
 * which is why the `?? []` below is load-bearing.
 */
export function lanAddresses(
  interfaces: { [name: string]: os.NetworkInterfaceInfo[] | undefined } = os.networkInterfaces(),
): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}

/** The request target's path component (query string stripped), or null when `req.url` is
 * not a parseable URL — such requests fall through to 404 instead of throwing into the
 * handler's 500 catch. Routing compares this exact pathname, never the raw target: a
 * startsWith on req.url answered ANY path prefixing a route (e.g. /api/transcripts?role=…
 * returned 200 transcript data), and an equality check on the raw target would miss query
 * strings on exact routes (/api/status?x → 404). */
function requestPathname(req: http.IncomingMessage): string | null {
  try {
    return new URL(req.url ?? "", "http://localhost").pathname;
  } catch {
    return null; // Unparseable target — not a route.
  }
}

/** Start the dashboard server. Binds to 127.0.0.1 by default; with `allInterfaces` it
 * binds the unspecified address (every interface, IPv4 and IPv6), making the dashboard —
 * including the director prompt box, which anyone reaching it can use to steer the fleet —
 * available to the whole network. There is no authentication; exposing it is the caller's
 * deliberate choice. Resolves once it is listening. */
export function startGui(root: string, port: number, allInterfaces = false): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = requestPathname(req);
      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(GUI_PAGE);
      } else if (req.method === "GET" && pathname === "/api/status") {
        sendJson(res, 200, statusPayload(root));
      } else if (req.method === "GET" && pathname === "/api/transcript") {
        handleTranscript(req, res, root);
      } else if (req.method === "GET" && pathname === "/api/backlog") {
        handleBacklog(req, res, root);
      } else if (req.method === "POST" && pathname === "/api/prompt") {
        // Client-side request failures get 4xx with an actionable message — not a 500
        // carrying Node's raw SyntaxError/TypeError, which misreports the fault and hides
        // the fix (send {"text": "..."}).
        let body: string;
        try {
          body = await readBody(req);
        } catch (err) {
          sendJson(res, 413, { error: errorMessage(err) }); // body too large
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          sendJson(res, 400, { error: 'body must be a JSON object like {"text": "..."}' });
          return;
        }
        // Valid JSON that is not an object ("just a string", [1], null) gets the same fix as
        // malformed JSON — "text required" would point at a field of a body that has none.
        // Arrays are objects in JS, so they need their own clause.
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          sendJson(res, 400, { error: 'body must be a JSON object like {"text": "..."}' });
          return;
        }
        const text = (parsed as { text?: unknown }).text;
        if (typeof text !== "string") {
          sendJson(
            res,
            400,
            { error: `text must be a string${text === undefined ? "" : ` (got ${JSON.stringify(text)})`}` },
          );
          return;
        }
        if (!text.trim()) {
          sendJson(res, 400, { error: "text required" });
          return;
        }
        submitPrompt(root, text);
        sendJson(res, 200, { ok: true });
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
    } catch (err) {
      sendJson(res, 500, { error: errorMessage(err) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    if (allInterfaces) server.listen(port, () => resolve(server));
    else server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
