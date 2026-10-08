import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type http from "node:http";
import {
  sendJson,
  readJsonObject,
  MAX_BODY_BYTES,
  bufferedBodyBytes,
} from "../src/gui/http-body.js";

// http-body.ts is the dashboard's shared request/response plumbing: every /api endpoint
// answers through sendJson and every /api POST handler reads its body through
// readJsonObject. The server-level tests (gui-server.test.ts, gui-operator.test.ts)
// exercise these through a real socket, which cannot control chunk framing — so the
// wire-level edge cases the module's comments promise (multi-byte UTF-8 split across
// chunks, buffering that stops at the cap, the shared byte counter releasing at settle)
// are pinned here against fake streams.

/** A minimal fake IncomingMessage: EventEmitter with the data/end/error events readBody
 *  listens for. Chunk framing is under the test's control, unlike a real socket.
 *  resume() is a no-op: on a real stream it just lets the pending bytes flow, and the
 *  fake delivers its chunks only when the test emits them. */
class FakeReq extends EventEmitter {
  resume(): void {}
}

/** A minimal fake ServerResponse recording writeHead/end calls for assertion. */
class FakeRes {
  status: number | null = null;
  headers: Record<string, string> | null = null;
  body = "";
  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    this.headers = headers;
  }
  end(body: string): void {
    this.body = body;
  }
}

function asRes(res: FakeRes): http.ServerResponse {
  return res as unknown as http.ServerResponse;
}

test("sendJson writes the status, a json content-type, and the serialized body", () => {
  const res = new FakeRes();
  sendJson(asRes(res), 201, { ok: true, n: 2 });
  assert.equal(res.status, 201);
  assert.equal(res.headers?.["content-type"], "application/json");
  assert.equal(res.body, JSON.stringify({ ok: true, n: 2 }));
});

test("readJsonObject resolves the parsed object for a valid JSON object body", async () => {
  const req = new FakeReq();
  const res = new FakeRes();
  const pending = readJsonObject(asReq(req), asRes(res), '{"prompt":"x"}');
  req.emit("data", Buffer.from('{"role":"feature"}'));
  req.emit("end");
  const parsed = await pending;
  assert.deepEqual(parsed, { role: "feature" });
  // No error response was written on the happy path.
  assert.equal(res.status, null);
});

function asReq(req: FakeReq): http.IncomingMessage {
  return req as unknown as http.IncomingMessage;
}

test("malformed JSON gets 400 with the example shape, never a parse error leak", async () => {
  const req = new FakeReq();
  const res = new FakeRes();
  const pending = readJsonObject(asReq(req), asRes(res), '{"prompt":"x"}');
  req.emit("data", Buffer.from("{not json"));
  req.emit("end");
  assert.equal(await pending, null);
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { error: 'body must be a JSON object like {"prompt":"x"}' });
});

for (const raw of ['"just a string"', "[1,2]", "null", "42", "true"]) {
  test(`valid JSON that is not an object (${raw}) gets the same 400 as malformed JSON`, async () => {
    const req = new FakeReq();
    const res = new FakeRes();
    const pending = readJsonObject(asReq(req), asRes(res), '{"prompt":"x"}');
    req.emit("data", Buffer.from(raw));
    req.emit("end");
    assert.equal(await pending, null);
    assert.equal(res.status, 400, "a non-object gets the client-fixable 400, not a 500");
    assert.match(res.body, /body must be a JSON object like/);
  });
}

test("a multi-byte UTF-8 character split across two chunks decodes intact", async () => {
  // The module's stated reason for buffering raw bytes and decoding once: chunk
  // boundaries are arbitrary TCP framing, so per-chunk decoding would replace each
  // split byte with U+FFFD. One 3-byte character (é) straddles the boundary here.
  const text = '{"prompt":"café"}'; // é is 2 bytes; the whole body is otherwise ASCII
  const bytes = Buffer.from(text, "utf8");
  const split = bytes.indexOf(Buffer.from("é", "utf8")) + 1; // mid-character
  const req = new FakeReq();
  const res = new FakeRes();
  const pending = readJsonObject(asReq(req), asRes(res), "{}");
  req.emit("data", bytes.subarray(0, split));
  req.emit("data", bytes.subarray(split));
  req.emit("end");
  const parsed = await pending;
  assert.deepEqual(parsed, { prompt: "café" }, "the split character must survive the framing");
});

test("a body of exactly MAX_BODY_BYTES is accepted; one byte more is rejected with 413", async () => {
  // The cap is a strict > comparison: the boundary value itself must pass, or a
  // full-sized legitimate prompt gets rejected.
  const filler = "a".repeat(MAX_BODY_BYTES - 8); // {"f":""} is 8 chars around the filler
  const body = Buffer.from(`{"f":"${filler}"}`);
  assert.equal(body.length, MAX_BODY_BYTES);
  {
    const req = new FakeReq();
    const res = new FakeRes();
    const pending = readJsonObject(asReq(req), asRes(res), "{}");
    req.emit("data", body);
    req.emit("end");
    const parsed = await pending;
    assert.equal(res.status, null, "exactly the cap is still a valid body");
    assert.deepEqual(parsed, { f: filler });
  }
  {
    const req = new FakeReq();
    const res = new FakeRes();
    const pending = readJsonObject(asReq(req), asRes(res), "{}");
    req.emit("data", Buffer.concat([body, Buffer.alloc(1, 0x62)])); // one byte over the cap
    const parsed = await pending;
    assert.equal(parsed, null);
    assert.equal(res.status, 413);
    // The 413 names both the cap and the offending size, so the operator can see how
    // far over they are (this body is one byte past MAX_BODY_BYTES).
    assert.deepEqual(JSON.parse(res.body), {
      error: `body too large: request is ${MAX_BODY_BYTES + 1} bytes, over the ${MAX_BODY_BYTES} byte (${MAX_BODY_BYTES / (1024 * 1024)} MiB) cap`,
    });
  }
});

test("an oversized body rejects with 413, releases its bytes, and stops buffering late chunks", async () => {
  const req = new FakeReq();
  const res = new FakeRes();
  assert.equal(bufferedBodyBytes(), 0, "no bytes are held between requests");
  const pending = readJsonObject(asReq(req), asRes(res), "{}");
  const underCap = Math.floor(MAX_BODY_BYTES / 2);
  req.emit("data", Buffer.alloc(underCap, 0x61));
  assert.equal(bufferedBodyBytes(), underCap, "bytes held while the body is under the cap");
  req.emit("data", Buffer.alloc(MAX_BODY_BYTES, 0x62)); // pushes well over the cap
  assert.equal(await pending, null);
  assert.equal(res.status, 413);
  assert.equal(bufferedBodyBytes(), 0, "the rejected request's bytes are released at rejection");
  // A client that keeps uploading after the rejection cannot grow the shared counter:
  // late chunks are drained and discarded.
  req.emit("data", Buffer.alloc(1000, 0x63));
  req.emit("end");
  assert.equal(bufferedBodyBytes(), 0, "post-rejection chunks are never buffered");
});

test("two concurrent reads each contribute to and release from the shared counter", async () => {
  const reqA = new FakeReq();
  const resA = new FakeRes();
  const reqB = new FakeReq();
  const resB = new FakeRes();
  const pendingA = readJsonObject(asReq(reqA), asRes(resA), "{}");
  reqA.emit("data", Buffer.alloc(100, 0x61));
  const pendingB = readJsonObject(asReq(reqB), asRes(resB), "{}");
  reqB.emit("data", Buffer.alloc(50, 0x62));
  assert.equal(bufferedBodyBytes(), 150, "both in-flight bodies count toward the shared cap");
  reqA.emit("end");
  reqB.emit("end");
  await pendingA;
  await pendingB;
  assert.equal(bufferedBodyBytes(), 0, "every settled request releases exactly its own bytes");
});

test("a read error surfaces as 413 (the client-fixable bucket), not a hang or a 500", async () => {
  const req = new FakeReq();
  const res = new FakeRes();
  const pending = readJsonObject(asReq(req), asRes(res), "{}");
  req.emit("error", new Error("socket hang up"));
  assert.equal(await pending, null);
  assert.equal(res.status, 413);
  assert.match(res.body, /socket hang up/);
  assert.equal(bufferedBodyBytes(), 0, "a failed read releases whatever it had buffered");
});

// An abandoned POST body — a client that disconnects mid-upload, or the server's own
// requestTimeout destroying the socket — emits `aborted`/`close` with neither `end` nor
// `error`. readBody must settle on those too: otherwise the handler awaits forever and the
// request's buffered bytes stay counted, one leak per abandoned upload. The timeout makes a
// regression fail loudly here instead of hanging the whole suite.
for (const event of ["close", "aborted"] as const) {
  test(`a request that emits ${event} before its body ends settles and releases its bytes`, { timeout: 2000 }, async () => {
    const req = new FakeReq();
    const res = new FakeRes();
    const pending = readJsonObject(asReq(req), asRes(res), "{}");
    req.emit("data", Buffer.alloc(100, 0x61));
    assert.equal(bufferedBodyBytes(), 100, "bytes held while the body is under the cap");
    req.emit(event);
    assert.equal(await pending, null);
    assert.equal(res.status, 413, "an abandoned read answers the client-fixable bucket, not a hang");
    assert.equal(bufferedBodyBytes(), 0, "a closed read releases whatever it had buffered");
  });
}
