// The claude-side role-notes surface (plans/agent-backends.md "What the pi extensions did,
// per backend", PLANS.md "Agent backends, part 5/7"): a dependency-free stdio MCP server the
// claude adapter passes via --mcp-config. Spawns the compiled server exactly as claude would
// and drives the JSON-RPC handshake, so the transport, the tool listing, the shared 4 KB cap,
// and the no-write-on-rejection promise are all covered end to end.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ROLE_NOTES_MAX_BYTES } from "../src/agent/role-notes-write.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

const SERVER = fileURLToPath(new URL("../src/agent/mcp/role-notes-server.js", import.meta.url));

interface McpResponse {
  jsonrpc: string;
  id: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Spawn the compiled server, send each request as one line, close stdin (which is the
 * server's exit condition), and resolve with the parsed responses. */
function runServer(requests: readonly unknown[], notesPath: string): Promise<{ responses: McpResponse[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, TUMWATER_NOTES_PATH: notesPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", () => {
      const responses = out
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as McpResponse);
      resolve({ responses, stderr });
    });
    for (const request of requests) child.stdin.write(JSON.stringify(request) + "\n");
    child.stdin.end();
  });
}

/** One `tools/call` request for the notebook tool. */
function call(id: number, text: unknown): unknown {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: "role_notes", arguments: { text } } };
}

test("the MCP server initializes, lists role_notes, and writes a note through tools/call", async () => {
  const notes = path.join(tmpdir(), "state", "notes", "feature.md");
  const { responses, stderr } = await runServer(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      call(3, "where things live"),
    ],
    notes,
  );
  assert.equal(stderr, "", "the server keeps stdout/stderr clean for the JSON-RPC stream");

  const init = responses.find((r) => r.id === 1);
  assert.equal((init?.result?.serverInfo as { name: string }).name, "tumwater");
  assert.equal((init?.result?.capabilities as { tools: unknown }).tools !== undefined, true);

  const list = responses.find((r) => r.id === 2)?.result?.tools as Array<{ name: string }>;
  assert.ok(list.some((t) => t.name === "role_notes"), "the tool is advertised under its MCP name");

  const callResponse = responses.find((r) => r.id === 3);
  assert.equal(callResponse?.result?.isError, undefined, "a valid note is not a tool error");
  assert.match((callResponse?.result?.content as Array<{ text: string }>)[0]!.text, /notebook saved/);
  assert.equal(fs.readFileSync(notes, "utf8"), "where things live");
});

test("the MCP server rejects an oversized note as a tool error and leaves the old note intact", async () => {
  const notes = path.join(tmpdir(), "notes.md");
  fs.writeFileSync(notes, "keep me");
  const { responses } = await runServer([call(1, "a".repeat(ROLE_NOTES_MAX_BYTES + 1))], notes);
  const result = responses[0]!.result!;
  assert.equal(result.isError, true, "an over-cap note is reported as a tool error, not a transport failure");
  assert.match((result.content as Array<{ text: string }>)[0]!.text, /shorten it to at most 4096 bytes/);
  assert.equal(fs.readFileSync(notes, "utf8"), "keep me", "the rejected call writes nothing");
});

test("the MCP server rejects a malformed text instead of clearing the notebook", async () => {
  const notes = path.join(tmpdir(), "notes.md");
  fs.writeFileSync(notes, "keep me");
  const { responses } = await runServer([call(1, 123)], notes);
  const result = responses[0]!.result!;
  assert.equal(result.isError, true);
  assert.match((result.content as Array<{ text: string }>)[0]!.text, /requires a string "text"/);
  assert.equal(fs.readFileSync(notes, "utf8"), "keep me");
});
