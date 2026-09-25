/** The dashboard HTTP server: routing, the shared-token gate, the static page, /api/status,
 * and the self-reload watch. Every /api endpoint's handler lives in gui-endpoints.ts — this
 * module owns the socket, not the data. */
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import { GUI_PAGE } from "./gui-page.js";
import { statusPayload } from "./status-payload.js";
import { captureStartupBuild, createReloadWatch, reexecSelf } from "./self-reload.js";
import { errorMessage } from "../text.js";
import {
  handleAbort,
  handleBacklog,
  handleBudget,
  handleFailures,
  handlePause,
  handlePauseRole,
  handlePrompt,
  handlePromptRole,
  handleReport,
  handleTranscript,
  handleWake,
  sendJson,
} from "./gui-endpoints.js";

/** Constant-time credential comparison for the shared-token gate: `timingSafeEqual` throws
 * on unequal lengths, so the length equality is the guard. A naive `===` string compare
 * would leak the token's length and prefix byte by byte. */
function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
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
 * available to the whole network. There is no authentication by default — exposing it is
 * the caller's deliberate choice — and an optional shared token (`gui --token <secret>`,
 * passed as `token`) gates every route: requests must carry it as `Authorization: Bearer
 * <token>` or `?token=`, anything else gets a 401 JSON error. An empty token means no
 * check — byte-for-byte the open server. Resolves once it is listening. */
export function startGui(
  root: string,
  port: number,
  allInterfaces = false,
  token = "",
): Promise<http.Server> {
  // The serving process's own startup stamp: added to every /api/status payload so the page can
  // notice a newer server (a redeploy or manual build re-execs this process) and reload itself.
  const startupBuild = captureStartupBuild();
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = requestPathname(req);
      // Opt-in shared-token gate, ahead of every route: with a token set, the page and all
      // /api endpoints require it as `Authorization: Bearer <token>` or `?token=`; anything
      // else — including `GET /` — gets the same JSON 401 every handler uses, deliberately
      // no HTML login form: the CLI prints the token-bearing URL, and a bare 401 body is the
      // honest signal that the URL needs `?token=`.
      if (token) {
        const auth = req.headers.authorization ?? "";
        const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
        const query = new URL(req.url ?? "", "http://localhost").searchParams;
        const provided = bearer || query.get("token") || "";
        if (!tokenMatches(token, provided)) {
          sendJson(res, 401, { error: "token required" });
          return;
        }
      }
      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(GUI_PAGE);
      } else if (req.method === "GET" && pathname === "/api/status") {
        sendJson(res, 200, { ...statusPayload(root), serverBuildSha: startupBuild?.sha ?? null });
      } else if (req.method === "GET" && pathname === "/api/report") {
        handleReport(req, res, root);
      } else if (req.method === "GET" && pathname === "/api/failures") {
        handleFailures(req, res, root);
      } else if (req.method === "GET" && pathname === "/api/transcript") {
        handleTranscript(req, res, root);
      } else if (req.method === "GET" && pathname === "/api/backlog") {
        handleBacklog(req, res, root);
      } else if (req.method === "POST" && pathname === "/api/prompt") {
        await handlePrompt(req, res, root);
      } else if (req.method === "POST" && pathname === "/api/prompt-role") {
        await handlePromptRole(req, res, root);
      } else if (req.method === "POST" && pathname === "/api/budget") {
        await handleBudget(req, res, root);
      } else if (req.method === "POST" && pathname === "/api/pause") {
        await handlePause(req, res, root);
      } else if (req.method === "POST" && pathname === "/api/wake") {
        await handleWake(req, res, root);
      } else if (req.method === "POST" && pathname === "/api/abort") {
        await handleAbort(req, res, root);
      } else if (req.method === "POST" && pathname === "/api/pause-role") {
        await handlePauseRole(req, res, root);      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
    } catch (err) {
      sendJson(res, 500, { error: errorMessage(err) });
    }
  });
  // Reload onto a newer compiled tree: close the server, then re-exec. The page's own poll sees
  // the new process's changed serverBuildSha and reloads; failed polls while the port is down
  // are swallowed by its existing catch.
  const reloadWatch = createReloadWatch({
    root,
    startupInfo: startupBuild,
    onTrigger: () => {
      server.close();
      reexecSelf();
    },
  });
  void reloadWatch.start();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    if (allInterfaces) server.listen(port, () => resolve(server));
    else server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
