// The codex write guard's trust lookup (src/agent/codex/codex-hook-trust.ts; plans/
// codex-write-guard.md "Trust (parts 4–5)"; PLANS.md "Write guard on Codex, part 4/9"): the
// trust key and `sha256:` hash tumwater asks codex's own `hooks/list` for, cached per codex
// version and hook definition. The tests run offline against fakeCodexAppServer, never a real
// codex (PRINCIPLES.md).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { codexHookTrust, lookupCodexHookTrust } from "../src/agent/codex/codex-hook-trust.js";
import { codexWriteGuardDefinition } from "../src/agent/codex/codex-write-guard.js";
import { identityAlive } from "../src/process/process.js";
import { fakeCodexAppServer } from "./fakes/fake-codex.js";
import { codexHookTrustPath } from "../src/paths.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

/** A fresh definition (the real guard's command) whose command the fake can parse and re-hash. */
function definition() {
  return codexWriteGuardDefinition();
}

test("a lookup returns the fake's key and sha256: hash", async () => {
  const fake = fakeCodexAppServer();
  try {
    const cwd = tmpdir();
    const def = definition();
    const trust = await lookupCodexHookTrust({ bin: fake.bin, env: process.env, cwd, definition: def });
    assert.equal(trust.key, "/<session-flags>/config.toml:pre_tool_use:0:0");
    assert.equal(trust.hash, `sha256:${createHash("sha256").update(def.command).digest("hex")}`);
  } finally {
    fake.restore();
  }
});

test("a second codexHookTrust with the same version and definition starts no app-server", async () => {
  const root = tmpdir();
  const cwd = tmpdir();
  const fake = fakeCodexAppServer();
  try {
    const def = definition();
    const first = await codexHookTrust(root, { bin: fake.bin, env: process.env, cwd, definition: def, timeoutMs: 5_000 });
    const second = await codexHookTrust(root, { bin: fake.bin, env: process.env, cwd, definition: def, timeoutMs: 5_000 });
    assert.deepEqual(first, second);
    // The cache hit spawns no app-server: exactly one start line.
    assert.equal(fs.readFileSync(fake.callsFile, "utf8").trim().split("\n").length, 1);
    const cached = JSON.parse(fs.readFileSync(codexHookTrustPath(root), "utf8"))[
      `0.163.0${JSON.stringify(def)}`
    ];
    assert.equal(cached.key, first.key);
    assert.equal(cached.hash, first.hash);
    assert.ok(typeof cached.checkedAt === "number", "cache entry records when it was checked");
  } finally {
    fake.restore();
  }
});

test("a changed definition timeout looks up again", async () => {
  const root = tmpdir();
  const cwd = tmpdir();
  const fake = fakeCodexAppServer();
  try {
    const def = definition();
    await codexHookTrust(root, { bin: fake.bin, env: process.env, cwd, definition: def });
    const other = { ...def, timeout: 31 };
    await codexHookTrust(root, { bin: fake.bin, env: process.env, cwd, definition: other });
    assert.equal(fs.readFileSync(fake.callsFile, "utf8").trim().split("\n").length, 2);
  } finally {
    fake.restore();
  }
});

test("a changed --version output looks up again", async () => {
  const root = tmpdir();
  const cwd = tmpdir();
  const oldFake = fakeCodexAppServer({ version: "0.163.0" });
  const newFake = fakeCodexAppServer({ version: "0.164.0" });
  try {
    const def = definition();
    await codexHookTrust(root, { bin: oldFake.bin, env: process.env, cwd, definition: def });
    await codexHookTrust(root, { bin: newFake.bin, env: process.env, cwd, definition: def });
    assert.equal(fs.readFileSync(oldFake.callsFile, "utf8").trim().split("\n").length, 1);
    assert.equal(fs.readFileSync(newFake.callsFile, "utf8").trim().split("\n").length, 1);
  } finally {
    oldFake.restore();
    newFake.restore();
  }
});

test("a hanging fake rejects within timeoutMs and its child is gone afterwards", async () => {
  const cwd = tmpdir();
  const fake = fakeCodexAppServer({ hang: true });
  try {
    const def = definition();
    await assert.rejects(
      lookupCodexHookTrust({ bin: fake.bin, env: process.env, cwd, definition: def, timeoutMs: 500 }),
      /timed out after 500 ms/,
    );
    // The fake records the app-server's process-identity handle (pid + kernel start time) in
    // its shell shim, before node even bootstraps the script, so it is immutable to a slow
    // cold start. identityAlive re-reads the OS start and compares, so a pid the kernel later
    // reuses for an unrelated process cannot read as THE app-server still alive.
    const identityLine = fs.readFileSync(fake.identityFile, "utf8").trim();
    const s = identityLine.indexOf(" ");
    const pid = Number(identityLine.slice(0, s));
    const start = identityLine.slice(s + 1).trim();
    assert.ok(Number.isInteger(pid) && pid > 0 && start.length > 0, `identity file held ${JSON.stringify(identityLine)}`);
    const identity = { pid, start };
    // A SIGKILLed process group's leader is reaped (the test process waits on its own child,
    // closing the handle only after the kernel reaps it), so the identity probe eventually
    // reports it not alive. Poll briefly because the reap trails the kill by a tick or two;
    // the bound now only reports a genuine hang, never a reused pid.
    const deadline = Date.now() + 2_000;
    let gone = false;
    while (Date.now() < deadline) {
      if (await identityAlive(identity)) {
        await new Promise((r) => setTimeout(r, 25));
      } else {
        gone = true;
        break;
      }
    }
    assert.equal(gone, true, `hanging app-server pid ${pid} still alive after the lookup timed out`);
  } finally {
    fake.restore();
  }
});

test("a hanging --version probe settles the WHOLE codexHookTrust within the one deadline", async () => {
  const root = tmpdir();
  const cwd = tmpdir();
  // Both halves hang: --version (the probe) and app-server (the lookup), so this proves the
  // whole failing lookup stays within the ONE deadline rather than adding the probe's bound on
  // top of the lookup's.
  const fake = fakeCodexAppServer({ versionHang: true, hang: true });
  try {
    const def = definition();
    const started = Date.now();
    await assert.rejects(
      codexHookTrust(root, { bin: fake.bin, env: process.env, cwd, definition: def, timeoutMs: 500 }),
      /timed out after/,
    );
    assert.ok(
      Date.now() - started < 5_000,
      `codexHookTrust did not settle within the bound (${Date.now() - started} ms)`,
    );
  } finally {
    fake.restore();
  }
});

test("a fake whose list holds no matching hook rejects with the message", async () => {
  const cwd = tmpdir();
  const fake = fakeCodexAppServer({ mismatch: true });
  try {
    const def = definition();
    await assert.rejects(
      lookupCodexHookTrust({ bin: fake.bin, env: process.env, cwd, definition: def, timeoutMs: 5_000 }),
      /codex listed no session-flag PreToolUse hook with this command/,
    );
  } finally {
    fake.restore();
  }
});

test("a list holding non-matching hooks before the guard's still matches the guard's hook", async () => {
  const cwd = tmpdir();
  const def = definition();
  const good = { source: "sessionFlags", eventName: "preToolUse", command: def.command, key: "GUARD", currentHash: "sha256:GOOD" };
  const fake = fakeCodexAppServer({
    resultData: {
      data: [
        5, // a data group that is not an object
        { hooks: "not-an-array" }, // a group whose hooks is not an array
        { hooks: [null] }, // a hook that is not an object
        { hooks: [{ source: "user", eventName: "preToolUse", command: def.command }] }, // wrong source
        { hooks: [{ source: "sessionFlags", eventName: "notification", command: def.command }] }, // wrong event
        { hooks: [{ source: "sessionFlags", eventName: "preToolUse", command: "different-command" }] }, // wrong command
        { hooks: [good] },
      ],
    },
  });
  try {
    const trust = await lookupCodexHookTrust({ bin: fake.bin, env: process.env, cwd, definition: def, timeoutMs: 5_000 });
    assert.equal(trust.key, "GUARD");
    assert.equal(trust.hash, "sha256:GOOD");
  } finally {
    fake.restore();
  }
});

test("a hooks/list result whose data is not an array rejects as having no matching hook", async () => {
  const cwd = tmpdir();
  const fake = fakeCodexAppServer({ resultData: { data: {} } });
  try {
    const def = definition();
    await assert.rejects(
      lookupCodexHookTrust({ bin: fake.bin, env: process.env, cwd, definition: def, timeoutMs: 5_000 }),
      /codex listed no session-flag PreToolUse hook with this command/,
    );
  } finally {
    fake.restore();
  }
});

test("an RPC error that is neither a string nor a {message} object names its JSON", async () => {
  const cwd = tmpdir();
  const fake = fakeCodexAppServer({ errorReply: { extra: 1, nested: { a: 2 } } });
  try {
    const def = definition();
    await assert.rejects(
      lookupCodexHookTrust({ bin: fake.bin, env: process.env, cwd, definition: def, timeoutMs: 5_000 }),
      /codex hooks\/list errored: \{"extra":1,"nested":\{"a":2\}\}/,
    );
  } finally {
    fake.restore();
  }
});

test("an RPC error reply rejects, naming the string error", async () => {
  const cwd = tmpdir();
  const fake = fakeCodexAppServer({ errorReply: "boom" });
  try {
    const def = definition();
    await assert.rejects(
      lookupCodexHookTrust({ bin: fake.bin, env: process.env, cwd, definition: def, timeoutMs: 5_000 }),
      /codex hooks\/list errored: boom/,
    );
  } finally {
    fake.restore();
  }
});

test("an RPC error reply object rejects with its message", async () => {
  const cwd = tmpdir();
  const fake = fakeCodexAppServer({ errorReply: { message: "nope" } });
  try {
    const def = definition();
    await assert.rejects(
      lookupCodexHookTrust({ bin: fake.bin, env: process.env, cwd, definition: def, timeoutMs: 5_000 }),
      /codex hooks\/list errored: nope/,
    );
  } finally {
    fake.restore();
  }
});

test("a non-JSON notice line on the stream is ignored", async () => {
  const cwd = tmpdir();
  const fake = fakeCodexAppServer({ noise: true });
  try {
    const def = definition();
    const trust = await lookupCodexHookTrust({ bin: fake.bin, env: process.env, cwd, definition: def, timeoutMs: 5_000 });
    assert.equal(trust.key, "/<session-flags>/config.toml:pre_tool_use:0:0");
    assert.equal(trust.hash, `sha256:${createHash("sha256").update(def.command).digest("hex")}`);
  } finally {
    fake.restore();
  }
});

test("an app-server that exits before hooks/list rejects with the early-exit message", async () => {
  const cwd = tmpdir();
  const fake = fakeCodexAppServer({ exitEarly: true });
  try {
    const def = definition();
    await assert.rejects(
      lookupCodexHookTrust({ bin: fake.bin, env: process.env, cwd, definition: def, timeoutMs: 5_000 }),
      /codex app-server exited \(code 0\) before answering hooks\/list/,
    );
  } finally {
    fake.restore();
  }
});

test("a corrupted cache entry is ignored and re-looked-up", async () => {
  const root = tmpdir();
  const cwd = tmpdir();
  const fake = fakeCodexAppServer();
  try {
    const def = definition();
    const file = codexHookTrustPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Seed the cache under whatever key this build's --version probe produces, then corrupt
    // that entry in place. Hardcoding the version prefix (0.163.0) made this test flaky: a
    // --version probe that times out under load reports "" (codexVersion's fallback), which
    // changes the cache key, so the corrupt-and-read-back keys diverged and the read-back
    // found only the marker. Seeding first means the corrupted key is always the real one.
    await codexHookTrust(root, { bin: fake.bin, env: process.env, cwd, definition: def, timeoutMs: 5_000 });
    const seeded = JSON.parse(fs.readFileSync(file, "utf8"));
    const entries = Object.entries(seeded);
    assert.equal(entries.length, 1, "the seed wrote exactly one cache entry");
    const seedKey = entries[0]![0];
    fs.writeFileSync(file, JSON.stringify({ [seedKey]: "not-a-trust" }));
    const trust = await codexHookTrust(root, { bin: fake.bin, env: process.env, cwd, definition: def, timeoutMs: 5_000 });
    assert.equal(trust.hash, `sha256:${createHash("sha256").update(def.command).digest("hex")}`);
    // The non-trust cache value did not short-circuit the lookup: exactly two app-server starts.
    assert.equal(fs.readFileSync(fake.callsFile, "utf8").trim().split("\n").length, 2);
    const cached = JSON.parse(fs.readFileSync(file, "utf8"))[seedKey];
    assert.equal(cached.key, trust.key);
    assert.equal(cached.hash, trust.hash);
  } finally {
    fake.restore();
  }
});

test("root undefined looks up and writes no file", async () => {
  const home = tmpdir();
  const cwd = tmpdir();
  const fake = fakeCodexAppServer();
  try {
    const def = definition();
    const trust = await codexHookTrust(undefined, { bin: fake.bin, env: process.env, cwd, definition: def, timeoutMs: 5_000 });
    assert.equal(trust.hash, `sha256:${createHash("sha256").update(def.command).digest("hex")}`);
    // A hand run with no .tumwater root must never mint a .tumwater directory anywhere.
    assert.equal(fs.existsSync(path.join(home, ".tumwater")), false);
    assert.equal(fs.existsSync(path.join(cwd, ".tumwater")), false);
  } finally {
    fake.restore();
  }
});
