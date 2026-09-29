import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { HarnessEvent } from "../src/events.js";
import { initProject } from "../src/init.js";
import { tickRows } from "../src/history-data.js";
import { writeEvents } from "./log-fixtures.js";
import { freshLoopState, saveLoopState } from "../src/loop-state.js";
import { dequeuePrompt, DIRECTOR_PROMPT_MAX_CHARS, enqueueRolePrompt, inboxSize, queuedRolePrompts } from "../src/inbox.js";
import { readEvents } from "../src/events.js";
import { DIRECTOR_ROLE } from "../src/roles.js";
import { bufferedBodyBytes, MAX_BODY_BYTES } from "../src/ui/http-body.js";
import { readBuildInfo, type BuildInfo } from "../src/build-info.js";
import { startGui } from "../src/ui/gui.js";
import { startLocalGui } from "./gui-fixtures.js";
import { makeRepo } from "./repo-fixtures.js";
import { waitFor } from "./wait.js";

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

test("gui answers 400 for an over-long prompt and queues nothing", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui long prompt test");
  const { server, base } = await startLocalGui(repo);
  try {
    // An over-long prompt is a user-input error: the shared length rule (inbox.ts's
    // promptLengthProblem) answers 400 naming the length and the ceiling — not the outer
    // catch's 500, which is reserved for unexpected submit failures (see the EACCES test).
    const res = await fetch(base + "/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(DIRECTOR_PROMPT_MAX_CHARS + 1) }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, new RegExp(`${DIRECTOR_PROMPT_MAX_CHARS + 1} chars`));
    assert.equal(inboxSize(repo), 0, "the rejected prompt queued nothing");
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

test("gui answers 401, not 500, for a malformed target on a token-gated server", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui malformed target token test");
  const { server, port } = await startLocalGui(repo, "s3cret");
  try {
    // The token gate reads the same parsed request target as the router, so a target the
    // URL parser rejects must answer the gate's 401 (the token check simply finds nothing
    // to match), never the 500 a gate-side re-parse throw would produce — the same bad
    // request that earns 404 on the token-less server in the test above.
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

    assert.match(response, /^HTTP\/1\.1 401/, `expected 401, got: ${response.split("\r\n")[0]}`);
    assert.match(response, /token required/);
    socket.destroy();

    // The gate still admits a well-formed request carrying the token.
    const ok = await fetch(`http://127.0.0.1:${port}/api/status?token=s3cret`);
    assert.equal(ok.status, 200);
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
    // stop). The server must reject at the cap, release what it kept, and DRAIN without
    // buffering — before the fix each late chunk was still appended to the body string,
    // growing it to the full upload size. Keep-alive (no Connection: close) keeps the
    // server-side request alive so a buggy buffer would still be held while we measure.
    //
    // The measurement is readBody's own buffered-byte counter, not a whole-process heap
    // delta: heap counts garbage and unrelated allocations too, so on a loaded host the old
    // heap assertion flipped between pass and fail with no code change — and the gate then
    // waved a failed-then-passed tree through as flake weather.
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
    // The counter rises by at most one chunk per data event and is zeroed the moment the cap
    // rejects, so it can never exceed this bound between samples either — sampling at every
    // write callback covers the whole upload deterministically. Track the max and assert
    // AFTER the upload: throwing inside the write-callback chain would stall the upload and
    // hang the test instead of failing it.
    const maxBuffered = MAX_BODY_BYTES + frame.length;
    let maxSeen = 0;
    await new Promise<void>((resolve, reject) => {
      let i = 0;
      socket.once("error", reject);
      const next = (): void => {
        maxSeen = Math.max(maxSeen, bufferedBodyBytes());
        if (i >= 256) return resolve();
        i++;
        socket.write(framed, next);
      };
      next();
    });
    assert.ok(
      maxSeen <= maxBuffered,
      `server kept up to ${maxSeen} bytes buffered of a rejected body (bound ${maxBuffered})`,
    );
    // Give the server a moment to finish draining what is still in flight.
    for (let waited = 0; waited < 2000 && !/^HTTP\/1\.1 413/.test(response); waited += 50) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(response, /^HTTP\/1\.1 413/, "the oversized upload still gets the 413");
    // Once the upload is in and the server has drained it, readBody holds nothing: the cap
    // rejection must have RELEASED what it kept, not merely stopped growing it.
    for (let waited = 0; waited < 2000 && bufferedBodyBytes() > 0; waited += 50) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(bufferedBodyBytes(), 0, "a rejected body's buffer is released, not retained");
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

test("/api/status exposes each loop's nextRunAt and backoffSeconds", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui schedule test");
  const state = freshLoopState("clean");
  state.nextRunAt = 1_758_800_000_000;
  state.backoffSeconds = 90;
  saveLoopState(repo, state);
  const { server, base } = await startLocalGui(repo);
  try {
    const status = (await (await fetch(base + "/api/status")).json()) as {
      loops: Array<{ role: string; nextRunAt: number; backoffSeconds: number }>;
    };
    const clean = status.loops.find((l) => l.role === "clean");
    assert.ok(clean, "the loop has a payload row");
    assert.equal(clean.nextRunAt, 1_758_800_000_000, "raw epoch ms — the GUI formats it client-side");
    assert.equal(clean.backoffSeconds, 90);
  } finally {
    server.close();
  }
});

// The per-role prompt endpoint sits behind the same body cap as /api/prompt: an oversized
// body is the client's 413, and the server stays healthy and accepts normal prompts after.
test("gui rejects oversized prompt-role bodies with 413 and stays healthy", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui prompt-role body limit test");
  const { server, base } = await startLocalGui(repo);
  try {
    const huge = JSON.stringify({ role: "clean", text: "x".repeat(70 * 1024) });
    const res = await fetch(base + "/api/prompt-role", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: huge,
    });
    assert.equal(res.status, 413);
    assert.match(await res.text(), /body too large/);

    const ok = await fetch(base + "/api/prompt-role", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "clean", text: "still alive" }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(queuedRolePrompts(repo, "clean"), ["still alive"]);
  } finally {
    server.close();
  }
});

// The queued-prompts rows' cancel affordance: POST /api/prompt-cancel removes exactly the
// prompt its queue file names — the file-addressed twin of the CLI's position-based
// `prompt --cancel`, so a 1 s-stale poll can never cancel the wrong entry.
test("gui /api/prompt-cancel removes one queued prompt by file, answers gone on a race", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui prompt-cancel test");
  const { server, base } = await startLocalGui(repo);
  try {
    const first = enqueueRolePrompt(repo, DIRECTOR_ROLE, "first prompt");
    const second = enqueueRolePrompt(repo, DIRECTOR_ROLE, "second prompt");
    const clean = enqueueRolePrompt(repo, "clean", "clean prompt");
    const post = (body: unknown) =>
      fetch(base + "/api/prompt-cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // Cancelling by file removes exactly that file, logs one prompt_cancelled event under
    // the director, and answers the preview for the flash line.
    let res = await post({ file: path.basename(first) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, status: "cancelled", preview: "first prompt" });
    assert.equal(inboxSize(repo), 1);
    assert.deepEqual(queuedRolePrompts(repo, DIRECTOR_ROLE), ["second prompt"]);
    assert.deepEqual(queuedRolePrompts(repo, "clean"), ["clean prompt"], "other queues untouched");
    const cancelled = readEvents(repo).filter((e) => e.type === "prompt_cancelled");
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0]!.loop, DIRECTOR_ROLE);
    assert.equal(cancelled[0]!.preview, "first prompt");

    // Re-cancelling the same file — or one the loop already dequeued — is "gone" (200),
    // data for the flash line, not a 500; and it logs no second event, removes nothing else.
    res = await post({ file: path.basename(first) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, status: "gone" });
    assert.equal(inboxSize(repo), 1);
    assert.equal(readEvents(repo).filter((e) => e.type === "prompt_cancelled").length, 1);

    // A role-scoped cancel targets that loop's own queue (role given explicitly).
    res = await post({ role: "clean", file: path.basename(clean) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, status: "cancelled", preview: "clean prompt" });
    assert.deepEqual(queuedRolePrompts(repo, "clean"), []);
    assert.equal(readEvents(repo).filter((e) => e.type === "prompt_cancelled").length, 2);
    assert.equal(readEvents(repo).filter((e) => e.type === "prompt_cancelled" && e.loop === "clean").length, 1);

    // A hostile or malformed file name is a user-input error: 400, nothing touched on disk.
    // "a\u0000.md" is the shape that once reached the fs layer and answered a 500: a NUL
    // byte is no character a filename can hold, so the fs call throws a non-ENOENT error
    // instead of the "gone" path — the guard must reject it before anything touches disk.
    for (const file of ["../escape.md", "a/b.md", "a\\b.md", "..", "a\u0000.md", "not-a-prompt.txt", "", undefined]) {
      res = await post({ file });
      assert.equal(res.status, 400, `file ${JSON.stringify(file)} rejected`);
      assert.match(await res.text(), /file/);
    }
    assert.equal(inboxSize(repo), 1, "the second director prompt survived every rejection");

    // An unknown role is the shared rejectBadRole 400, like /api/transcript.
    res = await post({ role: "nope", file: path.basename(second) });
    assert.equal(res.status, 400);
    // The error is a JSON body, so the id's quotes come back escaped.
    assert.match(await res.text(), /unknown role \\"nope\\"/);
    assert.equal(inboxSize(repo), 1);

    // A non-object body rides the shared readJsonObject 400.
    res = await fetch(base + "/api/prompt-cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[1,2]",
    });
    assert.equal(res.status, 400);
    assert.equal(inboxSize(repo), 1);
  } finally {
    server.close();
  }
});

test("gui /api/history serves tickRows' JSON with role filtering and n clamped, not errored", async () => {
  const repo = makeRepo();
  await initProject(repo, "history api test");
  // Seed interleaved tick_start/tick_end/unrelated events (the same shape the history CLI
  // tests seed): one tick with a paired start (durations come from the pair), one without
  // (a skipped tick's end rides no start — no fabricated duration), and a merged event that
  // tickRows must ignore.
  const events: HarnessEvent[] = [
    { ts: 1_000, loop: "feature", type: "tick_start", tick: 1 } as HarnessEvent,
    { ts: 46_000, loop: "feature", type: "tick_end", tick: 1, result: "changed", summary: "tidy up", tokens: 500, costUsd: 0.25 } as HarnessEvent,
    { ts: 47_000, loop: "steward", type: "merged", commit: "abc", summary: "unrelated" } as HarnessEvent,
    { ts: 48_000, loop: "clean", type: "tick_end", tick: 7, result: "no_change" } as HarnessEvent,
    { ts: 49_000, loop: "feature", type: "tick_end", tick: 2, result: "skipped" } as HarnessEvent,
    { ts: 50_000, loop: "clean", type: "tick_start", tick: 9 } as HarnessEvent,
    { ts: 96_000, loop: "clean", type: "tick_end", tick: 9, result: "changed", summary: "sorted imports" } as HarnessEvent,
  ];
  writeEvents(repo, events);

  const { server, base } = await startLocalGui(repo);
  try {
    // Default window: the JSON equals what `tumwater history` derives for the same window —
    // tickRows over the same seed, newest first, durations from tick_start pairs, null when
    // the start is outside the window.
    const res = await fetch(base + "/api/history");
    assert.equal(res.status, 200);
    const d = (await res.json()) as { rows: ReturnType<typeof tickRows> };
    assert.deepEqual(d, { rows: tickRows(events, 20, null) });
    assert.deepEqual(d.rows.map((r) => [r.loop, r.tick]), [["clean", 9], ["feature", 2], ["clean", 7], ["feature", 1]], "newest first");
    assert.equal(d.rows[0]!.durationMs, 46_000, "duration pairs the tick's own tick_start");
    assert.equal(d.rows[1]!.durationMs, null, "a skipped tick's end claims no duration");

    // role filters to that loop's rows (a filter is not a target: an id with no ticks is a
    // legitimate empty result, not an error — no config validation).
    const scoped = await (await fetch(base + "/api/history?role=clean")).json();
    assert.deepEqual(scoped, { rows: tickRows(events, 20, "clean") });
    const none = await fetch(base + "/api/history?role=nosuchloop");
    assert.equal(none.status, 200);
    assert.deepEqual(await none.json(), { rows: [] });

    // n: absent → 20; present but not a plain non-negative integer → 400 (the handleBacklog
    // index discipline); present and parseable → clamped to [1, 200], never errored.
    assert.deepEqual(await (await fetch(base + "/api/history?n=500")).json(), { rows: tickRows(events, 200, null) });
    const one = await (await fetch(base + "/api/history?n=0")).json();
    assert.deepEqual(one, { rows: tickRows(events, 1, null) }, "n=0 clamps up to 1");
    for (const bad of ["abc", "-5", "1e3", "0x10", "%207", ""]) {
      const r = await fetch(base + "/api/history?n=" + bad);
      assert.equal(r.status, 400, `n=${bad} → 400 (a non-count is a client error, unlike days)`);
      const body = (await r.json()) as { error: string };
      assert.match(body.error, /n must be a non-negative integer/);
    }
  } finally {
    server.close();
  }
});

test("gui /api/history grows its role-filtered scan window until it reaches the role's ticks", async () => {
  // The dilution case the CLI's `history --role` fix pinned: the first window (n*2+50 events)
  // fills with a busy sibling loop's tick_ends, so the filtered rows fall short while the
  // role's older ticks sit just past it. The endpoint must grow the scan like cmdHistory,
  // not return fewer rows (or an empty set) for a role the retained log covers.
  const repo = makeRepo();
  await initProject(repo, "history api dilution");
  const events: HarnessEvent[] = [];
  for (let i = 0; i < 5; i++) events.push({ ts: 1000 + i, loop: "qa", type: "tick_end", tick: i + 1, result: "changed", summary: `qa fix ${i}` });
  for (let i = 0; i < 60; i++) events.push({ ts: 2000 + i, loop: "clean", type: "tick_end", tick: i + 1, result: "no_change" });
  writeEvents(repo, events);
  const { server, base } = await startLocalGui(repo);
  try {
    const d = (await (await fetch(base + "/api/history?role=qa&n=5")).json()) as { rows: { loop: string; tick: number }[] };
    assert.deepEqual(d.rows.map((r) => [r.loop, r.tick]), [["qa", 5], ["qa", 4], ["qa", 3], ["qa", 2], ["qa", 1]], "all 5 qa rows despite the diluting sibling");
    // The honest shortfall: the log holds fewer qa ticks than asked and the scan reached the
    // log's start — what exists is returned, not an error or a hang.
    const short = (await (await fetch(base + "/api/history?role=qa&n=10")).json()) as { rows: unknown[] };
    assert.equal(short.rows.length, 5);
  } finally {
    server.close();
  }
});

test("gui /api/history serves an empty row set when the event log is missing, and the page carries the history tab", async () => {
  const repo = makeRepo();
  await initProject(repo, "history empty test");
  // No events.jsonl seeded — the endpoint reads files directly, so it serves with no fleet
  // running and no log at all: an empty row set, never a 500.
  const { server, base } = await startLocalGui(repo);
  try {
    const res = await fetch(base + "/api/history");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { rows: [] });

    // The page carries the fourth tab's nav anchor and its hidden view container.
    const page = await (await fetch(base + "/")).text();
    assert.match(page, /id="tab-history"/);
    assert.match(page, /id="history" hidden/);
  } finally {
    server.close();
  }
});

test("gui closes its server and re-execs exactly once when a newer build appears on disk", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui self-reload wiring");

  // The self-reload wiring (startGui's onTrigger: close, then re-exec) is the half of the
  // redeploy story createReloadWatch's own tests cannot pin — they drive the watch with a
  // test-local callback, so a gui that never closed its server or re-execed twice would pass
  // those. The watch only polls a self-hosted install, which a temp repo is not, so the test
  // injects the watch's seams instead: disk stamp reads come from a local variable, the
  // self-hosted gate is stubbed true, and the re-exec is a counter, never a spawn.
  const startup = readBuildInfo();
  assert.ok(startup, "the suite runs from a stamped dist");
  let disk: BuildInfo | null = startup;
  let reexecs = 0;
  const server = await startGui(repo, 0, false, "", {
    isSelfHostedImpl: async () => true,
    readDisk: () => disk,
    intervalMs: 10,
    reexec: () => {
      reexecs++;
    },
  });
  try {
    // A stamp naming the startup sha is not a newer build: several polls pass, nothing fires.
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(reexecs, 0, "an unchanged dist stamp never reloads");
    assert.equal(server.listening, true, "the server is still serving the current build");

    // A redeploy swaps dist/ under the serving process: the watch closes the server — the
    // re-exec's fresh process takes the port — and re-execs. Firing latches: a stamp that
    // changes again while the old process still winds down must not re-exec twice.
    disk = { ...startup, sha: `${startup.sha}-newer` };
    await waitFor(() => reexecs > 0, "the reload watch fires on a newer dist stamp", 5000);
    assert.equal(server.listening, false, "the server closed before the re-exec");
    disk = { ...startup, sha: "third-sha" };
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(reexecs, 1, "the reload fires at most once per process");
  } finally {
    server.close();
  }
});
