import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import {
  type BacklogEntry,
  openBugEntries,
  openQuestionEntries,
  plannedPlanEntries,
} from "../backlog.js";
import { submitPrompt } from "../inbox.js";
import { isJsonObject } from "../json-object.js";
import { knownRoleIds, loadConfigCached } from "../config.js";
import { checkDailyBudgetUsd, setDailyBudgetUsd } from "../config-write.js";
import { pauseFleet, resumeFleet } from "../fleet-state.js";
import { requestAbort, requestWake } from "../operator-commands.js";
import { GUI_PAGE } from "./gui-page.js";
import { allRoleIds } from "../roles.js";
import { REPORT_DEFAULT_DAYS, REPORT_MAX_DAYS, collectReport } from "./report.js";
import { collectFailureReport } from "../failure-data.js";
import { renderFailureMarkdown } from "../failure-report.js";
import { statusPayload } from "./status-payload.js";
import { readTranscript } from "./transcript.js";
import { captureStartupBuild, createReloadWatch, reexecSelf } from "./self-reload.js";
import { errorMessage, parseNonNegativeInt, parsePositiveInt } from "../text.js";

/** Send a JSON response with the given status code and body. Every /api endpoint answers
 * this way (errors included), so the content-type header lives in exactly one place. */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Constant-time credential comparison for the shared-token gate: `timingSafeEqual` throws
 * on unequal lengths, so the length equality is the guard. A naive `===` string compare
 * would leak the token's length and prefix byte by byte. */
function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** The role ids a loop-targeting endpoint accepts: when tumwater.json parses, catalog +
 * customLoops (knownRoleIds); a transiently broken file falls back to the built-in catalog
 * rather than refusing every id. Shared by /api/transcript and the two operator endpoints so
 * their validation and 400 wording cannot drift. */
function validRoleIds(root: string): string[] {
  const { config } = loadConfigCached(root);
  return config ? knownRoleIds(config) : allRoleIds();
}

/** Handle GET /api/transcript?role=<id>&n=N: rendered transcript lines for one loop's pi
 * log (same rendering as `tumwater logs --role <id>`). Unknown/missing role or a bad n → 400.
 * User-defined loops are valid targets too — the GUI marks them with an asterisk, so clicking
 * one must open its transcript: ids validate through validRoleIds. The 400 message lists
 * exactly the ids accepted. */
function handleTranscript(req: http.IncomingMessage, res: http.ServerResponse, root: string): void {
  const q = new URL(req.url ?? "", "http://localhost").searchParams;
  const role = q.get("role");
  const validIds = validRoleIds(root);
  if (role === null) {
    sendJson(res, 400, { error: `role required (valid ids: ${validIds.join(", ")})` });
    return;
  }
  if (!validIds.includes(role)) {
    sendJson(res, 400, { error: `unknown role ${JSON.stringify(role)} (valid ids: ${validIds.join(", ")})` });
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
  if (file === null) {
    sendJson(res, 400, { error: `file required (valid values: plans, bugs, questions)` });
    return;
  }
  let entries: BacklogEntry[] | null = null;
  if (file === "plans") entries = plannedPlanEntries(root);
  else if (file === "bugs") entries = openBugEntries(root);
  else if (file === "questions") entries = openQuestionEntries(root);
  if (!entries) {
    sendJson(res, 400, { error: `unknown file ${JSON.stringify(file)} (valid values: plans, bugs, questions)` });
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
    sendJson(res, 400, { error: `index ${index} out of range (${file} has ${entries.length} open entries)` });
    return;
  }
  sendJson(res, 200, { title: entry.title, body: entry.body });
}

/** The window both report endpoints serve, from ?days=N on the request. One exact rule,
 * shared so /api/report and /api/failures cannot drift: missing or non-decimal →
 * REPORT_DEFAULT_DAYS, out-of-range clamped to 1..REPORT_MAX_DAYS (the same bounds the CLI's
 * --days enforces, shared in report.ts) — never an error (a URL typo must degrade to the
 * default window, deliberately unlike handleTranscript's parsePositiveInt→400 idiom).
 * "Non-decimal" is the shared plain-digit rule (text.parseNonNegativeInt):
 * hex/scientific/signed/padded spellings are not counts and get the default instead of a
 * coerced value — raw Number.parseInt would read "1e3" as 1, "0x10" as 0, and "-5" as -5. */
function windowDays(req: http.IncomingMessage): number {
  const q = new URL(req.url ?? "", "http://localhost").searchParams;
  const n = parseNonNegativeInt(q.get("days") ?? "");
  return n === null ? REPORT_DEFAULT_DAYS : Math.min(REPORT_MAX_DAYS, Math.max(1, n));
}

/** Handle GET /api/report?days=N: the usage report data (collectReport's ReportData) as
 * JSON — the dashboard's report tab renders it. The days window follows windowDays. Reads
 * files directly, so it works whether or not the fleet is running. */
function handleReport(req: http.IncomingMessage, res: http.ServerResponse, root: string): void {
  sendJson(res, 200, collectReport(root, windowDays(req)));
}

/** Handle GET /api/failures?days=N: the same bounded Markdown failure digest the telemetry
 * loop feeds on and `tumwater report --failures` prints, as JSON ({ markdown }) — the
 * dashboard's failures tab renders it. The days window follows windowDays (so it can never
 * drift from /api/report's). Reads files directly, so it works with no fleet running. */
function handleFailures(req: http.IncomingMessage, res: http.ServerResponse, root: string): void {
  sendJson(res, 200, { markdown: renderFailureMarkdown(collectFailureReport(root, windowDays(req))) });
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

/** Read a POST body as a JSON object — the shared front half of every /api POST handler:
 * oversized bodies get 413, malformed or non-object bodies get 400 with `example` showing
 * the expected shape (client-side failures get an actionable message, not a 500 carrying
 * Node's raw SyntaxError/TypeError, which misreports the fault and hides the fix), and the
 * parsed object is returned — null once any 4xx was sent. */
async function readJsonObject(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  example: string,
): Promise<Record<string, unknown> | null> {
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    sendJson(res, 413, { error: errorMessage(err) }); // body too large
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: `body must be a JSON object like ${example}` });
    return null;
  }
  // Valid JSON that is not an object ("just a string", [1], null) gets the same fix as
  // malformed JSON — pointing at a field of a body that has none would mislead.
  if (!isJsonObject(parsed)) {
    sendJson(res, 400, { error: `body must be a JSON object like ${example}` });
    return null;
  }
  return parsed;
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
        const body = await readJsonObject(req, res, '{"text": "..."}');
        if (!body) return; // 4xx already sent — oversized or not a JSON object
        const text = body.text;
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
      } else if (req.method === "POST" && pathname === "/api/budget") {
        // The dashboard's budget-badge editor saves the daily cost cap here — same body
        // discipline as /api/prompt (readJsonObject), and the same shared validation rule +
        // atomic setter the TUI's Ctrl+B uses, so both surfaces write tumwater.json
        // identically and the running orchestrator picks the change up on its next ~2 s poll.
        const body = await readJsonObject(req, res, '{"maxDailyCostUsd": 25}');
        if (!body) return; // 4xx already sent — oversized or not a JSON object
        const value = body.maxDailyCostUsd;
        if (value === undefined) {
          sendJson(res, 400, { error: "maxDailyCostUsd required" });
          return;
        }
        // The shared rule (finite ≥ 0; 0 disables): missing/non-finite/negative → 400 with
        // the offending value named.
        const problem = checkDailyBudgetUsd(value);
        if (problem) {
          sendJson(res, 400, { error: problem });
          return;
        }
        const result = setDailyBudgetUsd(root, value as number);
        if (!result.ok) {
          // The value was valid — this is a server-side failure (broken tumwater.json or
          // disk), not the client's fault.
          sendJson(res, 500, { error: result.error });
          return;
        }
        sendJson(res, 200, { ok: true, maxDailyCostUsd: value as number });
      } else if (req.method === "POST" && pathname === "/api/pause") {
        // The dashboard header's pause/resume toggle: the same operator gate `tumwater pause`
        // and `resume` write, via fleet-state.ts's shared writers (pauseFleet/resumeFleet) so the CLI and
        // the GUI cannot drift on the marker's format or idempotence. Same body discipline as /api/prompt and
        // /api/budget (readJsonObject → 400 malformed/non-object, 413 oversized); the target
        // state is explicit (`paused: true|false`) rather than a toggle, so a retried request
        // is idempotent.
        const body = await readJsonObject(req, res, '{"paused": true}');
        if (!body) return; // 4xx already sent — oversized or not a JSON object
        const value = body.paused;
        if (typeof value !== "boolean") {
          sendJson(
            res,
            400,
            { error: `paused must be a boolean${value === undefined ? "" : ` (got ${JSON.stringify(value)})`}` },
          );
          return;
        }
        if (value) pauseFleet(root);
        else resumeFleet(root);
        sendJson(res, 200, { ok: true, paused: value });
      } else if (req.method === "POST" && pathname === "/api/wake") {
        // The dashboard's per-row wake control: the same marker-writing core `tumwater wake`
        // calls (requestWake), so the CLI and the GUI cannot drift on the state-file edits or
        // the marker. `{}`/a missing role targets every configured role (the CLI's all-roles
        // default); a given role validates exactly like /api/transcript. Same body
        // discipline as /api/pause (readJsonObject → 400 malformed/non-object, 413 oversized).
        const body = await readJsonObject(req, res, '{"role": "feature"}');
        if (!body) return; // 4xx already sent — oversized or not a JSON object
        const validIds = validRoleIds(root);
        const role = body.role;
        if (role !== undefined && (typeof role !== "string" || !validIds.includes(role))) {
          sendJson(res, 400, { error: `unknown role ${JSON.stringify(role)} (valid ids: ${validIds.join(", ")})` });
          return;
        }
        sendJson(res, 200, { ok: true, message: requestWake(root, role === undefined ? validIds : [role]) });
      } else if (req.method === "POST" && pathname === "/api/abort") {
        // The dashboard's per-row abort control: the same marker-writing core `tumwater abort`
        // calls (requestAbort). The role is required and validated like /api/transcript;
        // requestAbort's not-live error comes back 409 — the marker is valid but nothing can
        // consume it, a conflict rather than a client 400. The director variant's message
        // (the discarded-prompt note) rides through verbatim.
        const body = await readJsonObject(req, res, '{"role": "feature"}');
        if (!body) return; // 4xx already sent — oversized or not a JSON object
        const validIds = validRoleIds(root);
        if (typeof body.role !== "string" || !validIds.includes(body.role)) {
          sendJson(res, 400, { error: `unknown role ${JSON.stringify(body.role)} (valid ids: ${validIds.join(", ")})` });
          return;
        }
        const result = requestAbort(root, body.role);
        if (!result.ok) {
          sendJson(res, 409, { error: result.error });
          return;
        }
        sendJson(res, 200, { ok: true, message: result.message });
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
