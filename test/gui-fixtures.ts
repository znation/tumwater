/** GUI server scaffolding: the one fixture every gui*.test.ts needs before it can talk to the
 * server. Socket-level tests start startGui directly; the CLI binary harness lives in
 * cli-harness.ts. */
import type { Server } from "node:http";
import { strict as assert } from "node:assert";
import { startGui } from "../src/ui/gui.js";

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
