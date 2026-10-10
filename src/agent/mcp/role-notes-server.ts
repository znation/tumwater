/**
 * claude's `role_notes` surface (plans/agent-backends.md "What the pi extensions did, per
 * backend"): a dependency-free stdio MCP server shipped in dist. claude does not load pi's
 * bundled extensions, so the claude adapter passes this server via `--mcp-config` whenever the
 * run carries a notebook, and the model calls `mcp__tumwater__role_notes`. It is MCP rather
 * than "edit this file" because the notebook lives under `.tumwater/`, which the prompts
 * forbid touching, and because every future agent CLI speaks MCP.
 *
 * The write path is shared with the pi extension (src/agent/role-notes-write.ts), so the 4 KB
 * cap, the parameter schema, and the atomic write are the same on both backends. Only the
 * JSON-RPC framing lives here.
 *
 * Transport is the MCP stdio convention: one JSON-RPC 2.0 message per line on stdin/stdout,
 * and nothing else on stdout (logs would corrupt the stream). The server exits when stdin
 * closes — exactly the lifetime claude gives a configured MCP server.
 */

import { pathToFileURL } from "node:url";
import { ROLE_NOTES_DESCRIPTION, ROLE_NOTES_PARAMETERS, saveRoleNote } from "../role-notes-write.js";

const SERVER_NAME = "tumwater";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const ROLE_NOTES_TOOL = "role_notes";

/** Handle one JSON-RPC line and return the response line to write, or null for a
 * notification (no `id`). `notesPath` is the server's own TUMWATER_NOTES_PATH. */
function handleMcpLine(line: string, notesPath: string | undefined): unknown | null {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return errorResponse(null, -32700, "Parse error");
  }
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
    return errorResponse(null, -32600, "Invalid Request");
  }
  const method = msg.method;
  // A message with no method is a response to a request the server never sends; the CLIENT
  // does not send one, so ignoring it is correct. A notification (no id) is answered with
  // nothing in every case.
  if (typeof method !== "string") return null;
  const id = msg.id;
  const isNotification = id === undefined || id === null;
  const result = (value: Record<string, unknown>): unknown => ({ jsonrpc: "2.0", id, result: value });
  const respond = (value: Record<string, unknown>): unknown => (isNotification ? null : result(value));

  switch (method) {
    case "initialize": {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION;
      return respond({
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return respond({});
    case "tools/list":
      return respond({
        tools: [
          {
            name: ROLE_NOTES_TOOL,
            description: ROLE_NOTES_DESCRIPTION,
            inputSchema: ROLE_NOTES_PARAMETERS,
          },
        ],
      });
    case "tools/call": {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      if (params.name !== ROLE_NOTES_TOOL) {
        return respond(
          toolError(`unknown tool ${JSON.stringify(params.name)}; this server exposes ${ROLE_NOTES_TOOL}`),
        );
      }
      if (notesPath === undefined) {
        return respond(toolError("no notebook path is configured for this run"));
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        return respond({ content: [{ type: "text", text: saveRoleNote(notesPath, args.text) }] });
      } catch (err) {
        // Per MCP, a tool's own failure (bad input, a write error) is a successful JSON-RPC
        // response carrying isError, so the model sees a tool error and can retry — while a
        // JSON-RPC error would read as a transport failure of the whole server.
        return respond(toolError(err instanceof Error ? err.message : String(err)));
      }
    }
    default:
      return isNotification ? null : errorResponse(id, -32601, `Method not found: ${method}`);
  }
}

function toolError(text: string): { content: Array<{ type: string; text: string }>; isError: true } {
  return { content: [{ type: "text", text }], isError: true };
}

function errorResponse(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** Wire the handler to stdin/stdout and exit on EOF. */
function runRoleNotesServer(): void {
  const notesPath = process.env.TUMWATER_NOTES_PATH;
  let buffer = "";
  const flush = (line: string): void => {
    if (line.trim() === "") return;
    const response = handleMcpLine(line, notesPath);
    if (response !== null) process.stdout.write(JSON.stringify(response) + "\n");
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      flush(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  });
  process.stdin.on("end", () => {
    if (buffer !== "") flush(buffer);
  });
}

// Only run the transport when executed as the server; importing this module (the tests) must
// not attach stdin handlers. import.meta.url is the compiled file claude spawns by path.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRoleNotesServer();
}
