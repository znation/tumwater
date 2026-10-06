/** The dashboard HTTP server: routing, the shared-token gate, the static page, /api/status,
 * and the self-reload watch. Every /api endpoint's handler lives in gui/gui-endpoints.ts (the GET
 * data endpoints) and gui/gui-endpoint-commands.ts (the POST operator endpoints) — this
 * module owns the socket, not the data. The `tumwater gui` CLI entry (cmdGui) lives in gui/gui-command.ts,
 * which imports startGui from here, so the server and the command that boots it stay adjacent. */
import crypto from "node:crypto";
import http from "node:http";
import { GUI_PAGE } from "../ui/gui-page.js";
import { statusPayload } from "../ui/status-payload.js";
import {
  captureStartupBuild,
  createReloadWatch,
  reexecSelf,
  type ReloadWatchSeams,
  type SupervisorWatchSeams,
  watchReloadSupervisor,
} from "../redeploy/self-reload.js";
import { errorMessage } from "../text/text.js";
import {
  handleBacklog,
  handleConfig,
  handleFailures,
  handleReport,
  handleHistory,
  handleTick,
  handleTranscript,
} from "./gui-endpoints.js";
import {
  handleAbort,
  handleBudget,
  handleConfigSet,
  handlePause,
  handlePauseRole,
  handlePrompt,
  handlePromptCancel,
  handlePromptRole,
  handleRestart,
  handleWake,
} from "./gui-endpoint-commands.js";
import { sendJson } from "./http-body.js";

/** Constant-time credential comparison for the shared-token gate: `timingSafeEqual` throws
 * on unequal lengths, so the length equality is the guard. A naive `===` string compare
 * would leak the token's length and prefix byte by byte. */
function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** The request target parsed once (path, query, and the token gate all read the same
 * object), or null when `req.url` is not a parseable URL — such requests fall through to
 * 404 instead of throwing into the handler's 500 catch, token gate included: the gate reads
 * the same parsed target rather than re-parsing, so a malformed target answers 401 there
 * like the 404 it earns on the token-less server, never a 500 for a bad request.
 * Routing compares the exact pathname, never the raw target: a startsWith on req.url
 * answered ANY path prefixing a route (e.g. /api/transcripts?role=… returned 200 transcript
 * data), and an equality check on the raw target would miss query strings on exact routes
 * (/api/status?x → 404). */
function parseRequestTarget(req: http.IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? "", "http://localhost");
  } catch {
    return null; // Unparseable target — not a route.
  }
}

/** True when a request's Origin header names a server other than this one — the browser's
 * cross-origin signal. Browsers attach Origin to every cross-site POST (fetch and form
 * alike) and to same-origin POSTs too, so a POST from the dashboard carries this server's
 * own Host authority, while curl and scripts send no Origin at all. `Origin: null`
 * (sandboxed frames, data: redirects) is the hostile shape and is refused too. Pure header
 * reading, so the router can gate every POST route through it in one place. */
function crossOriginRequest(req: http.IncomingMessage): boolean {
  const raw = req.headers.origin;
  if (raw === undefined) return false; // no Origin: not a browser — allow
  const origin = Array.isArray(raw) ? raw[0] : raw;
  if (origin === "null") return true;
  try {
    return new URL(origin).host.toLowerCase() !== (req.headers.host ?? "").toLowerCase();
  } catch {
    return true; // unparseable Origin — refuse a signal we cannot verify
  }
}

/** Start the dashboard server. Binds to 127.0.0.1 by default; with `allInterfaces` it
 * binds the unspecified address (every interface, IPv4 and IPv6), making the dashboard —
 * including the director prompt box, which anyone reaching it can use to steer the fleet —
 * available to the whole network. There is no authentication by default — exposing it is
 * the caller's deliberate choice — and an optional shared token (`gui --token <secret>`,
 * passed as `token`) gates every route: requests must carry it as `Authorization: Bearer
 * <token>` or `?token=`, anything else gets a 401 JSON error. An empty token means no
 * check — byte-for-byte the open server. Resolves once it is listening.
 *
 * `watch` overrides the self-reload watch's seams (self-reload.ts's injectables) plus the
 * re-exec itself, and the supervised child's supervisor watch plus its exit; production
 * callers omit it and get the real disk-stamp poll, reexecSelf and process.exit — tests
 * inject fakes so the wiring (close, then re-exec, at most once; close, then exit, once the
 * reload supervisor is gone) is assertable without launching a process or touching this
 * dist's own stamp. */
export function startGui(
  root: string,
  port: number,
  allInterfaces = false,
  token = "",
  watch: ReloadWatchSeams & {
    reexec?: () => void;
    supervisor?: SupervisorWatchSeams;
    exit?: (code: number) => void;
  } = {},
): Promise<http.Server> {
  // The serving process's own startup stamp: added to every /api/status payload so the page can
  // notice a newer server (a redeploy or manual build re-execs this process) and reload itself.
  const startupBuild = captureStartupBuild();
  const server = http.createServer(async (req, res) => {
    try {
      const target = parseRequestTarget(req);
      const pathname = target?.pathname ?? null;
      // Opt-in shared-token gate, ahead of every route: with a token set, the page and all
      // /api endpoints require it as `Authorization: Bearer <token>` or `?token=`; anything
      // else — including `GET /` — gets the same JSON 401 every handler uses, deliberately
      // no HTML login form: the CLI prints the token-bearing URL, and a bare 401 body is the
      // honest signal that the URL needs `?token=`.
      if (token) {
        const auth = req.headers.authorization ?? "";
        const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
        const provided = bearer || target?.searchParams.get("token") || "";
        if (!tokenMatches(token, provided)) {
          sendJson(res, 401, { error: "token required" });
          return;
        }
      }
      // Cross-origin gate, ahead of every state-changing route: a hostile webpage can POST
      // to the open localhost server with a CORS-safelisted text/plain body (no preflight,
      // no readable response) and the side effect alone is the payload — a forged director
      // prompt, a fleet pause, an abort. Browsers mark every cross-site POST with an Origin
      // naming the hostile server, so one header check here refuses the forgery while the
      // dashboard's own POSTs (same-host Origin) and non-browser clients (no Origin) pass.
      if (req.method === "POST" && crossOriginRequest(req)) {
        sendJson(res, 403, {
          error: "cross-origin request rejected — dashboard POSTs must come from this dashboard's own origin",
        });
        return;
      }
      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(GUI_PAGE);
      } else if (req.method === "GET" && pathname === "/api/status") {
        sendJson(res, 200, { ...statusPayload(root), serverBuildSha: startupBuild?.sha ?? null });
      // The GET-data handlers receive the query from the one parsed target (route match
      // implies target parsed — pathname is non-null only then), not a re-parse of req.url.
      } else if (req.method === "GET" && pathname === "/api/report") {
        handleReport(target!.searchParams, res, root);
      } else if (req.method === "GET" && pathname === "/api/failures") {
        handleFailures(target!.searchParams, res, root);
      } else if (req.method === "GET" && pathname === "/api/history") {
        handleHistory(target!.searchParams, res, root);
      } else if (req.method === "GET" && pathname === "/api/transcript") {
        handleTranscript(target!.searchParams, res, root);
      } else if (req.method === "GET" && pathname === "/api/tick") {
        handleTick(target!.searchParams, res, root);
      } else if (req.method === "GET" && pathname === "/api/backlog") {
        handleBacklog(target!.searchParams, res, root);
      } else if (req.method === "GET" && pathname === "/api/config") {
        handleConfig(res, root);
      } else if (req.method === "POST" && pathname === "/api/config-set") {
        await handleConfigSet(req, res, root);
      } else if (req.method === "POST" && pathname === "/api/prompt") {
        await handlePrompt(req, res, root);
      } else if (req.method === "POST" && pathname === "/api/prompt-role") {
        await handlePromptRole(req, res, root);
      } else if (req.method === "POST" && pathname === "/api/prompt-cancel") {
        await handlePromptCancel(req, res, root);
      } else if (req.method === "POST" && pathname === "/api/budget") {
        await handleBudget(req, res, root);
      } else if (req.method === "POST" && pathname === "/api/pause") {
        await handlePause(req, res, root);
      } else if (req.method === "POST" && pathname === "/api/wake") {
        await handleWake(req, res, root);
      } else if (req.method === "POST" && pathname === "/api/restart") {
        await handleRestart(req, res, root);
      } else if (req.method === "POST" && pathname === "/api/abort") {
        await handleAbort(req, res, root);
      } else if (req.method === "POST" && pathname === "/api/pause-role") {
        await handlePauseRole(req, res, root);
      } else {
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
    ...watch,
    onTrigger: () => {
      server.close();
      (watch.reexec ?? reexecSelf)();
    },
  });
  void reloadWatch.start();
  // A reloaded child whose reload supervisor died outright: nothing will respawn or stop it,
  // so it frees the port and exits instead of serving on at PPID 1.
  const stopSupervisorWatch = watchReloadSupervisor(() => {
    reloadWatch.stop();
    server.close();
    (watch.exit ?? process.exit)(0);
  }, watch.supervisor);
  server.once("close", stopSupervisorWatch);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    if (allInterfaces) server.listen(port, () => resolve(server));
    else server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
