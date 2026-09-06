import http from "node:http";
import os from "node:os";
import { openBugs, openQuestions, plannedPlans } from "./backlog.js";
import { parsePositiveInt } from "./cli-args.js";
import { readEvents } from "./events.js";
import { formatEvent } from "./event-format.js";
import { submitPrompt } from "./inbox.js";
import { GUI_PAGE } from "./gui-page.js";
import { allRoleIds } from "./roles.js";
import { readLiveProgress } from "./progress.js";
import { dailyCost, budgetReached } from "./state.js";
import { snapshot } from "./status.js";
import { displayTokenMetrics, loopPhase } from "./status-render.js";
import { readTranscript } from "./transcript.js";
import { errorMessage } from "./text.js";

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

/** JSON payload for GET /api/status. */
export function statusPayload(root: string): object {
  const snap = snapshot(root);
  // The budget gate is fleet-wide (plans/daily-cost-budget.md): when today's spend has
  // reached the cap, every idle role loop's phase reads `budget paused` — one flag covers
  // both dashboards through loopPhase.
  const budgetPausedNow = budgetReached(snap.budget);
  return {
    running: snap.running,
    pid: snap.pid,
    inbox: snap.inbox,
    // Previews of the queued director prompts in execution order (truncated server-side —
    // see StatusSnapshot.inboxPrompts); the page lists them in its project status panel.
    inboxPrompts: snap.inboxPrompts,
    // The daily cost budget while enabled — the page derives its `· budget: $X/$Y today`
    // header badge from this (absent when disabled).
    budget: snap.budget ?? null,
    // Operator pause (`tumwater pause` marker present): every idle role loop's phase reads
    // `paused` ahead of budget/main-red — one flag covers both dashboards through loopPhase.
    paused: snap.paused,
    loops: snap.loops.map((s) => {
      // One live tail read per running loop per poll (was up to three — see renderStatus).
      const live = s.running ? readLiveProgress(root, s.role) : null;
      const m = displayTokenMetrics(root, s, live);
      return {
        role: s.role,
        phase: loopPhase(s, snap.running, root, budgetPausedNow, live, snap.paused),
        // What a working loop is doing right now (first assistant text of the in-flight run).
        // Null when idle — never show a stale item from a finished tick.
        currentWork: live?.currentWork ?? null,
        ticks: s.ticks,
        commits: s.commits,
        generated: m.generated,
        peakCtx: m.peakCtx,
        costUsd: s.totalCostUsd,
        // The loop's spend for the local day (the daily budget window): 0 while its stamp
        // is stale or missing — same helper and semantics as the TUI's `today` column.
        todayUsd: dailyCost(s),
        lastResult: s.lastResult ?? null,
        lastSummary: s.lastSummary ?? null,
        lastTickEndedAt: s.lastTickEndedAt ?? null,
      };
    }),
    events: readEvents(root, 40).map((e) => formatEvent(e)),
    // Project status (planned features + open bugs + open questions), fresh per poll like
    // events — loops edit these files constantly, so there is no cache to go stale. The page
    // derives the header badge count from this list's length.
    plans: plannedPlans(root),
    bugs: openBugs(root),
    questions: openQuestions(root),
  };
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

/** Start the dashboard server. Binds to 127.0.0.1 by default; with `allInterfaces` it
 * binds the unspecified address (every interface, IPv4 and IPv6), making the dashboard —
 * including the director prompt box, which anyone reaching it can use to steer the fleet —
 * available to the whole network. There is no authentication; exposing it is the caller's
 * deliberate choice. Resolves once it is listening. */
export function startGui(root: string, port: number, allInterfaces = false): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(GUI_PAGE);
      } else if (req.method === "GET" && req.url === "/api/status") {
        sendJson(res, 200, statusPayload(root));
      } else if (req.method === "GET" && req.url?.startsWith("/api/transcript")) {
        handleTranscript(req, res, root);
      } else if (req.method === "POST" && req.url === "/api/prompt") {
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
        const text = typeof parsed === "object" && parsed !== null ? (parsed as { text?: unknown }).text : undefined;
        if (typeof text !== "string" || !text.trim()) {
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
