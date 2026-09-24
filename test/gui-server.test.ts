import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { initProject } from "../src/init.js";
import { dequeuePrompt, inboxSize } from "../src/inbox.js";
import { makeRepo, startLocalGui } from "./util.js";

// The dashboard's HTTP server layer under hostile input: oversized and malformed bodies,
// raw-socket framing edge cases, and dropped clients. Each test pins a survivability
// guarantee — a bad request costs the client its own response, never the server.
// Sliced out of gui.test.ts, which covers the API and dashboard-page behavior instead.

test("gui rejects oversized prompt bodies with 413 instead of buffering them unboundedly", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui body limit test");
  const { server, base } = await startLocalGui(repo);
  try {
    // Just over the 64KB cap: a client error (413 Payload Too Large), not a server failure.
    const huge = JSON.stringify({ text: "x".repeat(70 * 1024) });
    const res = await fetch(base + "/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: huge,
    });
    assert.equal(res.status, 413);
    assert.match(await res.text(), /body too large/);

    // The server stays healthy afterwards and still accepts normal prompts.
    const ok = await fetch(base + "/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "still alive" }),
    });
    assert.equal(ok.status, 200);
    assert.equal(inboxSize(repo), 1);
  } finally {
    server.close();
  }
});

test("gui answers JSON 500 when a handler throws unexpectedly and keeps serving", async () => {
  // Skip under root, where chmod cannot stop the write and submitPrompt would succeed.
  if (typeof process.getuid === "function" && process.getuid() === 0) return;

  const repo = makeRepo();
  await initProject(repo, "gui handler error test");
  const { server, base } = await startLocalGui(repo);
  const inbox = path.join(repo, ".tumwater", "inbox");
  fs.mkdirSync(inbox, { recursive: true });
  try {
    // An unwritable inbox makes submitPrompt throw (EACCES) — an unexpected error inside a
    // request handler. Without the catch-all it would surface as an unhandled rejection and
    // kill the dashboard process over one bad request; with it, the client gets a JSON 500
    // naming the failure and every later request still works.
    fs.chmodSync(inbox, 0o555);

    const res = await fetch(base + "/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "this write will fail" }),
    });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /EACCES|permission denied/);
    assert.equal(inboxSize(repo), 0, "the failed prompt queued nothing");

    // The server survived the bad request and still serves.
    const status = await fetch(base + "/api/status");
    assert.equal(status.status, 200);
  } finally {
    fs.chmodSync(inbox, 0o755);
    server.close();
  }
});

test("multi-byte UTF-8 characters straddling chunk boundaries arrive intact", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui utf8 test");
  const { server, port } = await startLocalGui(repo);
  try {
    // A prompt containing a CJK character (3 bytes in UTF-8). The chunked upload is framed
    // so that character straddles two chunks — socket/chunk boundaries are arbitrary TCP
    // framing, and decoding each chunk independently would replace the split character with
    // U+FFFD, silently corrupting what the director receives.
    const text = "fix the 数据库 bug";
    const body = Buffer.from(JSON.stringify({ text }), "utf8");
    const charStart = body.indexOf(Buffer.from("数", "utf8"));
    assert.ok(charStart > 0 && charStart + 3 <= body.length, "test body contains the CJK character");
    const splitAt = charStart + 1; // inside the 3-byte sequence

    const socket = net.connect(port, "127.0.0.1");
    let response = "";
    socket.on("data", (d: Buffer) => {
      response += d.toString("ascii");
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.write(
        "POST /api/prompt HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n",
        () => resolve(),
      );
    });
    const frame = (b: Buffer): Buffer =>
      Buffer.concat([Buffer.from(`${b.length.toString(16)}\r\n`, "ascii"), b, Buffer.from("\r\n", "ascii")]);
    // Send the two halves as separate frames with a pause between them so the server reads
    // (and decodes) each chunk on its own — the condition that corrupts per-chunk decoding.
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.write(frame(body.subarray(0, splitAt)), () => setTimeout(resolve, 50));
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.write(Buffer.concat([frame(body.subarray(splitAt)), Buffer.from("0\r\n\r\n", "ascii")]), () => resolve());
    });
    // Wait for the response to land.
    await new Promise((r) => setTimeout(r, 200));

    assert.match(response, /^HTTP\/1\.1 200/, `expected 200, got: ${response.split("\r\n")[0]}`);
    const queued = dequeuePrompt(repo);
    assert.equal(queued, text, "the prompt arrives byte-for-byte intact");
    socket.destroy();
  } finally {
    server.close();
  }
});

test("gui answers 404, not 500, for a request target the URL parser rejects", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui malformed target test");
  const { server, base, port } = await startLocalGui(repo);
  try {
    // An absolute-form target whose host is malformed (`http://[`) is accepted by Node's HTTP
    // parser and handed to the handler as req.url, but `new URL(req.url, base)` throws on it.
    // requestPathname must swallow that and read as "no route" — a 404 — instead of letting
    // the throw reach the handler's 500 catch, which would report a server fault for what is
    // plainly a bad request. A raw socket is required: fetch/undici reject the malformed URL
    // client-side before it ever reaches the server.
    const socket = net.connect(port, "127.0.0.1");
    let response = "";
    socket.on("data", (d: Buffer) => {
      response += d.toString("ascii");
    });
    const ended = new Promise<void>((resolve) => socket.on("end", () => resolve()));
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.write("GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n", () => resolve());
    });
    await ended;

    assert.match(response, /^HTTP\/1\.1 404/, `expected 404, got: ${response.split("\r\n")[0]}`);
    assert.match(response, /not found/);
    socket.destroy();

    // The rejection is confined to the bad request: the server keeps routing well-formed ones.
    assert.equal((await fetch(base + "/nope")).status, 404);
    const status = await fetch(base + "/api/status");
    assert.equal(status.status, 200);
  } finally {
    server.close();
  }
});

test("oversized prompt bodies stop buffering at the cap (no unbounded growth)", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui body bound test");
  const { server, port } = await startLocalGui(repo);
  try {
    // A raw chunked upload of ~4MB in 16KB frames. The 413 lands after the first ~64KB, but
    // this client keeps sending every frame to completion (a well-behaved HTTP client would
    // stop). The server must reject at the cap and then DRAIN without buffering — before the
    // fix each late chunk was still appended to the body string, growing it to the full upload
    // size. Keep-alive (no Connection: close) keeps the server-side request alive so a buggy
    // buffer would still be retained when we measure.
    const socket = net.connect(port, "127.0.0.1");
    let response = "";
    socket.on("data", (d: Buffer) => {
      response += d.toString("ascii");
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.write(
        "POST /api/prompt HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n",
        () => resolve(),
      );
    });
    const frame = Buffer.alloc(16 * 1024, 0x78); // 'x'
    const framed = Buffer.concat([Buffer.from(`${frame.length.toString(16)}\r\n`, "ascii"), frame, Buffer.from("\r\n", "ascii")]);
    (globalThis as { gc?: () => void }).gc?.();
    const before = process.memoryUsage().heapUsed;
    await new Promise<void>((resolve, reject) => {
      let i = 0;
      socket.once("error", reject);
      const next = (): void => {
        if (i >= 256) return resolve();
        i++;
        socket.write(framed, next);
      };
      next();
    });
    // Give the server a moment to finish draining what is still in flight.
    await new Promise((r) => setTimeout(r, 300));
    (globalThis as { gc?: () => void }).gc?.();
    const growth = process.memoryUsage().heapUsed - before;
    assert.ok(growth < 1_048_576, `server retained ~${(growth / 1024 / 1024).toFixed(1)}MB of a rejected body`);
    assert.match(response, /^HTTP\/1\.1 413/, "the oversized upload still gets the 413");
    socket.destroy();
  } finally {
    server.close();
  }
});

test("gui survives a client that disconnects mid-upload and keeps serving", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui aborted upload test");
  const { server, base, port } = await startLocalGui(repo);
  try {
    // A client that vanishes mid-upload (browser closed, flaky LAN): the body is cut off
    // short of Content-Length, so Node fires 'error' (ECONNRESET) on the request stream.
    // readBody must settle via that error — a handler left awaiting a never-settling promise
    // would leak one per aborted upload, and an uncaught error from the dead connection could
    // kill the dashboard over one dropped client. The partial body is not valid JSON, so even
    // a regression that resolved it early could only 400 — nothing may be queued.
    const socket = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.write(
        "POST /api/prompt HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 4096\r\nConnection: close\r\n\r\n" +
          '{"text": "cut off mid', // partial body — far short of Content-Length
        () => resolve(),
      );
    });
    await new Promise((r) => setTimeout(r, 50)); // let the server start reading the body
    socket.destroy(); // client gone before the body completes

    // Give the error path a moment to settle (req 'error' → readBody reject → handler catch).
    await new Promise((r) => setTimeout(r, 200));

    // The aborted upload queued nothing — a partial body must never become a prompt.
    assert.equal(inboxSize(repo), 0, "the aborted upload queued no prompt");

    // The dashboard survived the dropped connection and still serves: status answers and a
    // fresh, complete prompt is accepted end to end.
    assert.equal((await fetch(base + "/api/status")).status, 200);
    const res = await fetch(base + "/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "sent after the abort" }),
    });
    assert.equal(res.status, 200);
    assert.equal(dequeuePrompt(repo), "sent after the abort");
  } finally {
    server.close();
  }
});

test("gui rejects oversized wake and abort bodies with 413 and keeps serving", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui operator body limit test");
  const { server, base } = await startLocalGui(repo);
  try {
    // Same shared readJsonObject guard as /api/prompt: just over the 64KB cap is a client
    // error, not a server failure, and no marker file is left behind by either endpoint.
    const huge = JSON.stringify({ role: "feature", pad: "x".repeat(70 * 1024) });
    for (const endpoint of ["/api/wake", "/api/abort"]) {
      const res = await fetch(base + endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: huge,
      });
      assert.equal(res.status, 413, endpoint);
      assert.match(await res.text(), /body too large/);
    }
    // The server stays healthy and still serves its status payload.
    assert.equal((await fetch(base + "/api/status")).status, 200);
  } finally {
    server.close();
  }
});
