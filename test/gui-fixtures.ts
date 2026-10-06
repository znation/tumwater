/** GUI server scaffolding: the one fixture every gui*.test.ts needs before it can talk to the
 * server. Socket-level tests start startGui directly; the CLI binary harness lives in
 * cli-harness.ts. */
import type { Server } from "node:http";
import { strict as assert } from "node:assert";
import { startGui } from "../src/gui/gui-server.js";

/** Start the GUI server on an ephemeral port and return it with its `http://127.0.0.1:<port>`
 * base URL: the same three lines (startGui on port 0, narrow the address, build the base)
 * every GUI test needs before it can talk to the server, shared so the narrowing and URL
 * cannot drift between the four gui*.test.ts files. Socket-level tests take `port` via
 * startGui directly; `token` starts a token-protected server for the auth-gate tests. */
export async function startLocalGui(
  root: string,
  token = "",
): Promise<{ server: Server; base: string; port: number }> {
  const server = await startGui(root, 0, false, token);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  return { server, base: `http://127.0.0.1:${addr.port}`, port: addr.port };
}

/** GET a loopback URL with a hard deadline and one retry. A loaded host can stall or refuse
 * the first connection to a just-listened socket, and the old unbounded fetch turned that
 * hiccup into a gate failure; the retry survives one. The second failure still throws, so a
 * genuinely unreachable server is never hidden. `fetchFn` is injectable so the retry itself
 * is testable without a stalled host. */
export async function fetchLoopback(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  try {
    return await fetchFn(url, { signal: AbortSignal.timeout(5_000) });
  } catch {
    return await fetchFn(url, { signal: AbortSignal.timeout(5_000) });
  }
}

/** POST a JSON body to a local GUI endpoint and return the raw Response: the four-line fetch
 * scaffold (method, the JSON content-type header, JSON.stringify of the payload) every
 * gui*.test.ts call site hand-rolled, shared so the request shape cannot drift between them.
 * The Response itself comes back — callers assert on `status` and parse the body themselves,
 * error bodies included. `extraHeaders` merges over the defaults (the cross-origin tests'
 * Origin). Tests posting raw or malformed BYTES (the 413/400 probes) keep their own
 * hand-rolled fetch: there the bytes are the point, and stringify would double-encode them. */
export function postJson(
  base: string,
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

/** Run `body` against a freshly started local GUI server and close the server either way —
 * the try/finally (`server.close()` in the finally, so a throwing body can never leak a
 * listening server into the next test) every startLocalGui call site hand-rolls, as one
 * call. `body` receives the base URL and port and destructures what it uses; `token`
 * starts a token-protected server for the auth-gate tests. */
export async function withGui<T>(
  root: string,
  body: (gui: { base: string; port: number }) => Promise<T>,
  token = "",
): Promise<T> {
  const { server, base, port } = await startLocalGui(root, token);
  try {
    return await body({ base, port });
  } finally {
    server.close();
  }
}
