import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import { initProject } from "../src/init.js";
import { lanAddresses } from "../src/ui/gui.js";
import { makeRepo } from "./repo-fixtures.js";
import { cli, spawnCli } from "./cli-harness.js";

// `tumwater gui` through the real CLI entry point: argument validation, the serve loop
// (banner, --token gate, --all-interfaces LAN URLs), and the failure paths (port in use,
// permission errors). The CLI runs main() on import and reports failures via process.exit,
// so it is tested as a child process through the spawn helpers in cli-harness.ts; gui.test.ts
// pins startGui/lanAddresses in-process.

async function freeTcpPort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test("gui --port validates its range instead of listening on an unexpected port", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli gui validation");

  // Port 0 would listen on an ephemeral port while printing http://127.0.0.1:0.
  for (const bad of ["0", "-1", "99999", "abc"]) {
    const r = await cli(repo, "gui", "--port", bad);
    assert.equal(r.code, 1, `--port ${bad} should fail`);
    assert.match(r.stderr, /--port must be an integer between 1 and 65535/);
  }

  const noValue = await cli(repo, "gui", "--port");
  assert.equal(noValue.code, 1);
  assert.match(noValue.stderr, /--port needs a value/);

  // --all-interfaces is part of gui's vocabulary: with it present, a bad port still fails
  // on the port (not as an unknown argument).
  const withAll = await cli(repo, "gui", "--all-interfaces", "--port", "abc");
  assert.equal(withAll.code, 1);
  assert.match(withAll.stderr, /--port must be an integer/);
});

test("gui starts, prints its banner, and --all-interfaces names the LAN exposure", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli gui serve");

  // Default binding: the banner names localhost only, with no all-interfaces warning.
  const localPort = await freeTcpPort();
  const local = spawnCli(repo, ["gui", "--port", String(localPort)]);
  try {
    await local.waitFor((b) => b.includes(`tumwater gui at http://127.0.0.1:${localPort}`), "the gui banner", 30_000);
    assert.ok(!local.out().includes("ALL interfaces"), "default bind does not claim all interfaces");
  } finally {
    local.kill();
  }

  // --all-interfaces: the concrete LAN URLs and the no-auth warning join the banner.
  const lanPort = await freeTcpPort();
  const lan = spawnCli(repo, ["gui", "--port", String(lanPort), "--all-interfaces"]);
  try {
    await lan.waitFor((b) => b.includes("listening on ALL interfaces"), "the all-interfaces warning", 30_000);
    for (const addr of lanAddresses())
      assert.ok(
        lan.out().includes(`also at http://${addr}:${lanPort}`),
        `names the LAN address ${addr}`,
      );
  } finally {
    lan.kill();
  }
});

test("gui reports a friendly error when the port is already in use", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli gui busy port");

  // Occupy an ephemeral port so the CLI hits EADDRINUSE deterministically; without the
  // catch it printed Node's raw "listen EADDRINUSE: address already in use …" with no hint.
  const blocker = http.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const addr = blocker.address();
  assert.ok(addr && typeof addr === "object");
  try {
    const r = await cli(repo, "gui", "--port", String(addr.port));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already in use/);
    assert.match(r.stderr, /tumwater gui --port <n>/);
  } finally {
    blocker.close();
  }
});

test("gui --token demands a non-empty secret instead of serving unauthenticated", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli gui token validation");

  // A valueless --token is the same mistake as an empty one: an operator who asked for
  // protection must get a CLI error, never a server with no auth (this test also bounds a
  // regression that started serving — the spawn helper's timeout kills it and the exit
  // code / stderr assertions fail).
  const valueless = await cli(repo, "gui", "--token");
  assert.equal(valueless.code, 1);
  assert.match(valueless.stderr, /--token requires a non-empty secret/);

  const empty = await cli(repo, "gui", "--token", "");
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /--token requires a non-empty secret/);

  // A flag-looking value is rejected too: a valued flag claims the next token even when
  // it is a known flag, so without this guard `--token --all-interfaces` would serve with
  // the literal secret "--all-interfaces" — and --all-interfaces still takes effect (it
  // is read straight from args), so the error is about the secret, not the bind width.
  const flagValue = await cli(repo, "gui", "--token", "--all-interfaces");
  assert.equal(flagValue.code, 1);
  assert.match(flagValue.stderr, /flag-looking value "--all-interfaces"/);
  assert.match(flagValue.stderr, /its own argument/);
});

test("gui --token serves behind the gate and prints the token-bearing URL", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli gui token serve");

  const port = await freeTcpPort();
  const gui = spawnCli(repo, ["gui", "--port", String(port), "--token", "s3cret"]);
  try {
    // The banner URL carries the token: an operator pasting the printed link must land
    // inside the gate, not on a bare 401 with no hint of what is missing.
    await gui.waitFor(
      (b) => b.includes(`tumwater gui at http://127.0.0.1:${port}/?token=s3cret`),
      "the token-bearing banner",
      30_000,
    );
    // The gate is live from the first response: without the token, even the page is 401.
    const bare = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(bare.status, 401);
    assert.deepEqual(await bare.json(), { error: "token required" });
  } finally {
    gui.kill();
  }
});

test("gui passes a permission error through with the raw message", async () => {
  // Privileged ports need root; as an unprivileged user this deterministically yields
  // EACCES, which the CLI must not swallow into the port-in-use hint. Skipped under root,
  // where port 80 would bind and serve forever.
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const repo = makeRepo();
  await initProject(repo, "cli gui eacces");

  const r = await cli(repo, "gui", "--port", "80");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /EACCES/);
});

test("gui --all-interfaces prints the reachable LAN URLs and serves until killed", async () => {
  // The success path of `tumwater gui` (banner, LAN URL lines, exposure warning) is only
  // reachable with a live child: startGui resolves once listening, then the CLI prints and
  // blocks. README documents that --all-interfaces "prints the LAN URLs it is reachable at";
  // lanAddresses' filter semantics are pinned in test/gui.test.ts (this e2e covers the
  // printing wiring against whatever interfaces this machine actually has).
  const repo = makeRepo();
  await initProject(repo, "cli gui all interfaces");

  // Claim a free port: bind an ephemeral listener, take its number, release it.
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  // The URLs the CLI should print: every non-loopback IPv4 address of this machine —
  // computed here (the same filter lanAddresses applies) so the test checks the printed
  // lines against reality instead of a hardcoded IP. Empty on machines without one.
  const expected = Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => Boolean(a && a.family === "IPv4" && !a.internal))
    .map((a) => a.address);

  const s = spawnCli(repo, ["gui", "--port", String(port), "--all-interfaces"]);
  try {
    // Wait for the LAST of the three synchronous startup writes (banner → URL lines →
    // warning), so every line is present before asserting.
    await s.waitFor(
      (out) => out.includes(`tumwater gui at http://127.0.0.1:${port}`) && out.includes("listening on ALL interfaces"),
      "the gui banner and exposure warning",
    );

    // The no-auth exposure warning is printed whenever --all-interfaces is used.
    assert.match(s.out(), /listening on ALL interfaces — no auth; anyone reaching it can prompt the director/);

    // Every non-loopback IPv4 address gets exactly one URL line, and nothing else does:
    // a regression that also printed loopback or IPv6 would add extra lines (the count
    // check catches it), and dropping an interface would miss its line.
    for (const addr of expected) {
      assert.ok(s.out().includes(`also at http://${addr}:${port}`), `missing URL for ${addr}:\n${s.out()}`);
    }
    const alsoLines = s.out().split("\n").filter((l) => l.includes("also at http://"));
    assert.equal(alsoLines.length, expected.length, `exactly one line per LAN address:\n${s.out()}`);

    // The server is actually up and serving the dashboard (binding every interface
    // includes loopback).
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(page, /<title>tumwater<\/title>/);
  } finally {
    s.kill();
  }
});
