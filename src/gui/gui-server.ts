/** The dashboard HTTP server: routing, the shared-token gate, the static page, /api/status,
 * and the self-reload watch. Every /api endpoint's handler lives in gui/gui-endpoints.ts (the GET
 * data endpoints) and gui/gui-endpoint-commands.ts (the POST operator endpoints) — this
 * module owns the socket, not the data. The `tumwater gui` CLI entry (cmdGui) lives in gui/gui-command.ts,
 * which imports startGui from here, so the server and the command that boots it stay adjacent. */
import crypto from "node:crypto";
import http from "node:http";
import { GUI_PAGE } from "../ui/gui/gui-page.js";
import { statusPayload } from "../ui/status-payload.js";
import {
  captureStartupBuild,
  createReloadWatch,
  reexecSelf,
  type ReloadWatchSeams,
  type SupervisorWatchSeams,
  watchReloadSupervisor,
} from "../redeploy/self-reload.js";
import { warnEvent } from "../events/events.js";
import { errorMessage } from "../text/text.js";
import {
  handleBacklog,
  handleConfig,
  handleDiff,
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

/** A dashboard route handler: the one callback shape guiRoutes stores per `METHOD path`, so its
 * table can hold the page, the JSON GET handlers, and the POST operator handlers together.
 * `target` is the already-parsed request URL (parseRequestTarget); a handler that needs the
 * query reads it from there instead of re-parsing req.url. */
type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: URL,
) => void | Promise<void>;

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

/** The address `startGui` binds for a given `allInterfaces` choice: loopback-only by default,
 * the unspecified address (`undefined` — every interface, IPv4 and IPv6) on request. Pure and
 * host-independent, so the mapping is testable without a live socket or this host's address
 * family. */
export function guiBindHost(allInterfaces: boolean): string | undefined {
  return allInterfaces ? undefined : "127.0.0.1";
}

/** Whether a request's `Host` header names the loopback-bound server itself — `localhost`,
 * `127.0.0.1`, or `::1`, each with or without its port (`[::1]:7180` bracketed). The check
 * exists for a loopback-bound server only (see startGui): a browser that resolves an
 * attacker-controlled name to 127.0.0.1 (DNS rebinding) reaches a loopback socket while its
 * page's origin and the request's Host both name the attacker's domain, so crossOriginRequest's
 * Origin/Host comparison calls the forged request same-origin. The Host is the one header the
 * rebinding browser must set to that domain, so refusing a non-loopback Host closes both the
 * read endpoints and the state-changing POSTs to a server reachable only from this machine.
 * A non-bracketed IPv6 literal is malformed per RFC 7230 and is not accepted. Pure, so the
 * parsing is testable without a socket. */
export function loopbackHostAllowed(hostHeader: string): boolean {
  let host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return false;
    host = host.slice(1, end);
  } else {
    const colon = host.lastIndexOf(":");
    if (colon !== -1) host = host.slice(0, colon);
  }
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
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
  // The routes as one table, keyed by `METHOD path`: dispatch is a single lookup where the
  // previous twenty-branch if/else chain restated `req.method === … && pathname === …` on
  // every arm. Each path appears once (the page's two spellings share servePage), so lookup
  // order carries no meaning. A handler that needs the query reads the one parsed target
  // (parseRequestTarget) — routing matched its exact pathname, so the target is non-null.
  const servePage = (_req: http.IncomingMessage, res: http.ServerResponse): void => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(GUI_PAGE);
  };
  const guiRoutes: Record<string, RouteHandler> = {
    "GET /": servePage,
    "GET /index.html": servePage,
    "GET /api/status": (_req, res) => {
      sendJson(res, 200, { ...statusPayload(root), serverBuildSha: startupBuild?.sha ?? null });
    },
    "GET /api/report": (_req, res, target) => handleReport(target.searchParams, res, root),
    "GET /api/failures": (_req, res, target) => handleFailures(target.searchParams, res, root),
    "GET /api/history": (_req, res, target) => handleHistory(target.searchParams, res, root),
    "GET /api/transcript": (_req, res, target) => handleTranscript(target.searchParams, res, root),
    "GET /api/tick": (_req, res, target) => handleTick(target.searchParams, res, root),
    "GET /api/diff": (_req, res, target) => handleDiff(target.searchParams, res, root),
    "GET /api/backlog": (_req, res, target) => handleBacklog(target.searchParams, res, root),
    "GET /api/config": (_req, res) => handleConfig(res, root),
    "POST /api/config-set": (req, res) => handleConfigSet(req, res, root),
    "POST /api/prompt": (req, res) => handlePrompt(req, res, root),
    "POST /api/prompt-role": (req, res) => handlePromptRole(req, res, root),
    "POST /api/prompt-cancel": (req, res) => handlePromptCancel(req, res, root),
    "POST /api/budget": (req, res) => handleBudget(req, res, root),
    "POST /api/pause": (req, res) => handlePause(req, res, root),
    "POST /api/wake": (req, res) => handleWake(req, res, root),
    "POST /api/restart": (req, res) => handleRestart(req, res, root),
    "POST /api/abort": (req, res) => handleAbort(req, res, root),
    "POST /api/pause-role": (req, res) => handlePauseRole(req, res, root),
  };
  const server = http.createServer(async (req, res) => {
    try {
      const target = parseRequestTarget(req);
      const pathname = target?.pathname ?? null;
      // DNS-rebinding gate, ahead of every route on a loopback-bound server: a hostile page
      // whose domain resolves to 127.0.0.1 is same-origin with this server, so the
      // cross-origin gate below cannot tell its requests from the dashboard's — but its
      // Host header must name the attacker's domain, which a request to the loopback
      // dashboard never legitimately does. Refusing that Host blocks the read endpoints
      // (status, config, transcripts) and the state-changing POSTs together. An
      // all-interfaces server is deliberately network-facing, so it keeps accepting every
      // Host (the operator's exposure choice); a token, if set, still gates it.
      if (!allInterfaces && !loopbackHostAllowed(req.headers.host ?? "")) {
        sendJson(res, 403, {
          error: "request Host is not this loopback dashboard's — a rebinding name is refused",
        });
        return;
      }
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
      const route = guiRoutes[`${req.method ?? ""} ${pathname ?? ""}`];
      if (route) await route(req, res, target!);
      else {
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
    const onListenError = (err: Error): void => reject(err);
    server.once("error", onListenError);
    const onListening = (): void => {
      // The listen-time listener must not outlive the listen: an 'error' after this point
      // would call reject on a settled promise and be swallowed. Replace it with a handler
      // that records the failure, so a post-listen socket error (EMFILE on accept, …) is
      // visible in the event feed instead of silently leaving a dead dashboard.
      server.removeListener("error", onListenError);
      server.on("error", (err) => warnEvent(root, "harness", `dashboard server error: ${errorMessage(err)}`));
      resolve(server);
    };
    const host = guiBindHost(allInterfaces);
    if (host === undefined) server.listen(port, onListening);
    else server.listen(port, host, onListening);
  });
}
