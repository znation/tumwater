import http from "node:http";
import { readEvents } from "./events.js";
import { formatEvent } from "./event-format.js";
import { submitPrompt } from "./inbox.js";
import { GUI_PAGE } from "./gui-page.js";
import { allRoleIds } from "./roles.js";
import { snapshot } from "./status.js";
import { displayTokenMetrics, loopPhase } from "./status-render.js";
import { readTranscript } from "./transcript.js";

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
    n = Number(nRaw);
    if (!Number.isInteger(n) || n < 1) {
      sendJson(res, 400, { error: `n must be a positive integer (got ${JSON.stringify(nRaw)})` });
      return;
    }
  }
  sendJson(res, 200, { lines: readTranscript(root, role, n) });
}

/** JSON payload for GET /api/status. */
export function statusPayload(root: string): object {
  const snap = snapshot(root);
  return {
    running: snap.running,
    pid: snap.pid,
    inbox: snap.inbox,
    loops: snap.loops.map((s) => {
      const m = displayTokenMetrics(root, s);
      return {
        role: s.role,
        phase: loopPhase(s, snap.running, root),
        ticks: s.ticks,
        commits: s.commits,
        generated: m.generated,
        peakCtx: m.peakCtx,
      costUsd: s.totalCostUsd,
        lastResult: s.lastResult ?? null,
        lastSummary: s.lastSummary ?? null,
        lastTickEndedAt: s.lastTickEndedAt ?? null,
      };
    }),
    events: readEvents(root, 40).map((e) => formatEvent(e)),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > 64 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** Start the dashboard server on 127.0.0.1. Resolves once it is listening. */
export function startGui(root: string, port: number): Promise<http.Server> {
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
          sendJson(res, 413, { error: err instanceof Error ? err.message : String(err) }); // body too large
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
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
