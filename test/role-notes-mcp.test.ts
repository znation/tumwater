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
import { MAX_MCP_LINE_CHARS } from "../src/agent/mcp/role-notes-server.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

const SERVER = fileURLToPath(new URL("../src/agent/mcp/role-notes-server.js", import.meta.url));

interface McpResponse {
  jsonrpc: string;
  id: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Spawn the compiled server, send each request as one line, close stdin (which is the
 * server's exit condition), and resolve with the parsed responses. A request given as a
 * string is sent verbatim (for malformed frames); `notesPath === undefined` leaves
 * TUMWATER_NOTES_PATH unset, the no-notebook server configuration. */
function runServer(
  requests: readonly unknown[],
  notesPath: string | undefined,
): Promise<{ responses: McpResponse[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (notesPath === undefined) delete env.TUMWATER_NOTES_PATH;
    else env.TUMWATER_NOTES_PATH = notesPath;
    const child = spawn(process.execPath, [SERVER], {
      env,
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
    for (const request of requests) {
      child.stdin.write((typeof request === "string" ? request : JSON.stringify(request)) + "\n");
    }
    child.stdin.end();
  });
}

/** Spawn the compiled server and write `script` to stdin exactly, without adding a trailing
 * newline — the server must still flush a final unterminated line when stdin closes. */
function runServerScript(script: string, notesPath: string | undefined): Promise<McpResponse[]> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (notesPath === undefined) delete env.TUMWATER_NOTES_PATH;
    else env.TUMWATER_NOTES_PATH = notesPath;
    const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", () => {
      resolve(
        out
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((l) => JSON.parse(l) as McpResponse),
      );
    });
    child.stdin.write(script);
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

test("the MCP server answers ping and drops notifications, methodless messages, and unknown notifications", async () => {
  const notes = path.join(tmpdir(), "notes.md");
  const { responses } = await runServer(
    [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/cancelled" },
      { jsonrpc: "2.0", id: 2, method: "unknown/method" },
      { jsonrpc: "2.0", method: "unknown/notification" },
      { jsonrpc: "2.0", id: null, method: "ping" },
      { jsonrpc: "2.0", id: 3, result: {} },
    ],
    notes,
  );
  assert.deepEqual(responses.map((r) => r.id), [1, 2], "only the two requests carrying an id are answered");
  assert.deepEqual(responses[0]!.result, {});
  assert.equal(responses[1]!.error?.code, -32601);
  assert.match(responses[1]!.error?.message ?? "", /Method not found: unknown\/method/);
});

test("initialize falls back to the default protocol version and a call without arguments is a tool error", async () => {
  const notes = path.join(tmpdir(), "notes.md");
  const { responses } = await runServer(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "role_notes" } },
    ],
    notes,
  );
  assert.equal(responses[0]!.result?.protocolVersion, "2024-11-05");
  const result = responses[1]!.result!;
  assert.equal(result.isError, true);
  assert.match((result.content as Array<{ text: string }>)[0]!.text, /requires a string "text"/);
});

test("the server reports an unknown tool and a missing notebook path as tool errors", async () => {
  const notes = path.join(tmpdir(), "notes.md");
  const { responses } = await runServer(
    [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "other", arguments: { text: "x" } } }],
    notes,
  );
  const unknown = responses[0]!.result!;
  assert.equal(unknown.isError, true);
  assert.match((unknown.content as Array<{ text: string }>)[0]!.text, /unknown tool "other"/);

  const bare = await runServer([call(1, "x")], undefined);
  const noPath = bare.responses[0]!.result!;
  assert.equal(noPath.isError, true);
  assert.match((noPath.content as Array<{ text: string }>)[0]!.text, /no notebook path is configured/);
});

test("malformed frames get the matching JSON-RPC error, one response per line", async () => {
  const notes = path.join(tmpdir(), "notes.md");
  const { responses } = await runServer(["{ not json", "null", "[]", "42"], notes);
  assert.deepEqual(
    responses.map((r) => r.error?.code),
    [-32700, -32600, -32600, -32600],
  );
});

test("a failed notebook write is a tool error and keeps the server answering", async () => {
  const notes = path.join(tmpdir(), "notes-dir");
  fs.mkdirSync(notes, { recursive: true });
  const { responses } = await runServer([call(1, "x"), { jsonrpc: "2.0", id: 2, method: "ping" }], notes);
  assert.equal(responses[0]!.result?.isError, true, "a directory in the note's place fails as a tool error");
  assert.deepEqual(responses[1]!.result, {}, "the stream survives the tool failure");
});

test("an over-cap frame without a newline is answered and the stream resynchronizes", async () => {
  // A client (or a broken pipe) that streams bytes without ever terminating a line must not
  // grow the server's buffer without bound: past MAX_MCP_LINE_CHARS the frame is discarded and
  // answered, and the next newline resumes normal framing. The server must answer BEFORE the
  // frame's own newline arrives — that is the buffer bound doing its job, not JSON.parse on a
  // line that was allowed to grow whole.
  const notes = path.join(tmpdir(), "notes.md");
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, TUMWATER_NOTES_PATH: notes },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
  try {
    const errorLine = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("no response to the over-cap frame before it was terminated")),
        5000,
      );
      timer.unref();
      const check = (): void => {
        const nl = out.indexOf("\n");
        if (nl < 0) return;
        clearTimeout(timer);
        child.stdout.off("data", check);
        resolve(out.slice(0, nl));
      };
      child.stdout.on("data", check);
      child.stdin.write("x".repeat(MAX_MCP_LINE_CHARS + 1));
    });
    const error = JSON.parse(errorLine) as McpResponse;
    assert.equal(error.error?.code, -32700, "the discarded frame is a JSON-RPC parse error");
    assert.equal(error.id, null);
    assert.match(error.error?.message ?? "", /exceeded 1 MiB/);

    child.stdin.end("\n" + JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }) + "\n");
    const responses = await new Promise<McpResponse[]>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", () =>
        resolve(
          out
            .split("\n")
            .filter((l) => l.trim() !== "")
            .map((l) => JSON.parse(l) as McpResponse),
        ),
      );
    });
    assert.deepEqual(responses.map((r) => r.id), [null, 9], "the post-overflow frame is served normally");
    assert.deepEqual(responses[1]!.result, {});
  } finally {
    // A failed assertion must not leave the spawned server (and its open stdin) behind to hang
    // the runner; a closed child's kill is a no-op.
    child.kill("SIGKILL");
  }
});

test("a final unterminated line is flushed when stdin closes", async () => {
  const notes = path.join(tmpdir(), "notes.md");
  const responses = await runServerScript(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }), notes);
  assert.deepEqual(responses.map((r) => r.id), [7]);
  assert.deepEqual(responses[0]!.result, {});
});

test("blank and whitespace-only lines are ignored without a response", async () => {
  const notes = path.join(tmpdir(), "notes.md");
  const { responses } = await runServer(["", "   ", { jsonrpc: "2.0", id: 1, method: "ping" }], notes);
  assert.deepEqual(responses.map((r) => r.id), [1]);
});

test("importing the server module starts no transport", async () => {
  const before = { data: process.stdin.listenerCount("data"), end: process.stdin.listenerCount("end") };
  await import("../src/agent/mcp/role-notes-server.js");
  assert.equal(process.stdin.listenerCount("data"), before.data, "importing must not attach stdin handlers");
  assert.equal(process.stdin.listenerCount("end"), before.end);
});
