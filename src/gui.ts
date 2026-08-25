import http from "node:http";
import { formatEvent, readEvents } from "./events.js";
import { submitPrompt } from "./inbox.js";
import { GUI_PAGE } from "./gui-page.js";
import { allRoleIds } from "./roles.js";
import { snapshot } from "./status.js";
import { loopPhase } from "./status-render.js";
import { readTranscript } from "./transcript.js";

/** Handle GET /api/transcript?role=<id>&n=N: rendered transcript lines for one loop's pi
 * log (same rendering as `tumwater logs --role <id>`). Unknown/missing role or a bad n → 400. */
function handleTranscript(req: http.IncomingMessage, res: http.ServerResponse, root: string): void {
  const q = new URL(req.url ?? "", "http://localhost").searchParams;
  const role = q.get("role");
  if (!role || !allRoleIds().includes(role)) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `unknown or missing role (valid ids: ${allRoleIds().join(", ")})` }));
    return;
  }
  let n = 50;
  const nRaw = q.get("n");
  if (nRaw !== null) {
    n = Number(nRaw);
    if (!Number.isInteger(n) || n < 1) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `n must be a positive integer (got ${JSON.stringify(nRaw)})` }));
      return;
    }
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ lines: readTranscript(root, role, n) }));
}

/** JSON payload for GET /api/status. */
export function statusPayload(root: string): object {
  const snap = snapshot(root);
  return {
    running: snap.running,
    pid: snap.pid,
    inbox: snap.inbox,
    loops: snap.loops.map((s) => ({
      role: s.role,
      phase: loopPhase(s, snap.running, root),
      ticks: s.ticks,
      commits: s.commits,
      tokens: s.totalTokens,
      costUsd: s.totalCostUsd,
      lastResult: s.lastResult ?? null,
      lastSummary: s.lastSummary ?? null,
      lastTickEndedAt: s.lastTickEndedAt ?? null,
    })),
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
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(statusPayload(root)));
      } else if (req.method === "GET" && req.url?.startsWith("/api/transcript")) {
        handleTranscript(req, res, root);
      } else if (req.method === "POST" && req.url === "/api/prompt") {
        const { text } = JSON.parse(await readBody(req)) as { text?: string };
        if (typeof text !== "string" || !text.trim()) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "text required" }));
          return;
        }
        submitPrompt(root, text);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
