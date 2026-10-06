import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { distDir, buildInfoPath } from "../src/build/build-info.js";
import { initProject } from "../src/init/init.js";
import { pidAlive } from "../src/process/process.js";
import { enqueueLanding } from "../src/landing/landing-queue.js";
import { cmdGui, lanAddresses, type GuiSeams } from "../src/gui/gui-command.js";
import { makeRepo, runningAsRoot, sh, tmpdir } from "./repo-fixtures.js";
import { sleep, waitFor } from "./wait.js";
import { SUPERVISED_ENV } from "../src/process/supervisor.js";
import { cli, spawnCli } from "./cli-harness.js";
import { exitWithOwnerEnv } from "./victim-fixture.js";

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

test("gui gates on a ready repo, but names a flag typo before the gate", async () => {
  // Outside any git repo the dispatch's ready-repo gate answers with readiness.ts's
  // wording (exit 1) — the operator's diagnosis, like every other gated command's.
  const dir = tmpdir();
  const bare = await cli(dir, "gui");
  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /not a git repository/);

  // The arg gate runs first by design (cli.ts's gui case re-runs parsePortFlag in its
  // validate so the typo is named before the ready-repo gate can mask it): a bad --port
  // outside a repo names the port, not the repo.
  const typo = await cli(dir, "gui", "--port", "abc");
  assert.equal(typo.code, 1);
  assert.match(typo.stderr, /--port must be an integer between 1 and 65535/);
  assert.doesNotMatch(typo.stderr, /not a git repository/);
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

test("the served /api/status carries the land queue's entries", async () => {
  // The land-queue drawer is client-side script; this e2e covers its server half: enqueue a
  // landing in the repo, start the gui, and read the same payload the 1 s poll delivers —
  // the entries the drawer renders must reach the client in queue order.
  const repo = makeRepo();
  await initProject(repo, "cli gui land queue");
  enqueueLanding(repo, { role: "clean", sha: "abc1234", tick: 1, summary: "tidy something", enqueuedAt: Date.now() });
  enqueueLanding(repo, { role: "feature", sha: "def5678", tick: 2, summary: "add a thing", enqueuedAt: Date.now() });

  const port = await freeTcpPort();
  const gui = spawnCli(repo, ["gui", "--port", String(port)]);
  try {
    await gui.waitFor((b) => b.includes(`tumwater gui at http://127.0.0.1:${port}`), "the gui banner", 30_000);
    const snap = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.equal(snap.landQueue.depth, 2);
    assert.deepEqual(
      snap.landQueue.entries.map((e: { role: string; sha: string; tick: number; summary: string; enqueuedAt: number }) =>
        [e.role, e.sha, e.tick, e.summary, typeof e.enqueuedAt]),
      [["clean", "abc1234", 1, "tidy something", "number"], ["feature", "def5678", 2, "add a thing", "number"]],
      "the queued changes reach the client oldest first",
    );
  } finally {
    gui.kill();
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

test("gui names the fix for a permission-denied port", async () => {
  // Privileged ports need root; as an unprivileged user this deterministically yields
  // EACCES, which the CLI must turn into its own hint — distinct from the port-in-use one,
  // since the fixes differ (stop that process vs pick an unprivileged port). Skipped under
  // root, where port 80 would bind and serve forever.
  if (runningAsRoot()) return;
  const repo = makeRepo();
  await initProject(repo, "cli gui eacces");

  const r = await cli(repo, "gui", "--port", "80");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /permission denied/);
  assert.match(r.stderr, /unprivileged port/);
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

test("gui --all-interfaces --token prints the protected warning and token-bearing LAN URLs", async () => {
  // The README's recommended exposure is exactly this pairing: --all-interfaces "so pair it
  // with --token <secret>". Each half was covered alone (token-less all-interfaces prints the
  // no-auth warning; token binds localhost only), so the token branch of the exposure warning
  // and the tokenSuffix on the LAN URL lines had never executed: a swap of the warning's two
  // branches, or a dropped tokenSuffix, would ship printed LAN links dead on arrival at the
  // 401 gate without a single test failing.
  const repo = makeRepo();
  await initProject(repo, "cli gui token all interfaces");

  const port = await freeTcpPort();
  const gui = spawnCli(repo, ["gui", "--port", String(port), "--all-interfaces", "--token", "s3cret"]);
  try {
    // Wait for the LAST of the synchronous startup writes (the warning line), so every line
    // is present before asserting — the same tail the token-less all-interfaces test waits on.
    await gui.waitFor(
      (out) =>
        out.includes(`tumwater gui at http://127.0.0.1:${port}/?token=s3cret`) &&
        out.includes("listening on ALL interfaces"),
      "the gui banner and exposure warning",
      30_000,
    );

    // The protected warning replaces the no-auth one — checking both forms means a
    // regression that prints one, the other, or both fails either way.
    assert.match(
      gui.out(),
      /listening on ALL interfaces — token-protected; prompting the director requires the token/,
    );
    assert.ok(!gui.out().includes("no auth; anyone reaching it can prompt the director"));

    // Every printed LAN URL must be openable: it carries the same token the gate demands,
    // or the link lands on a bare 401 (vacuous on a machine with no LAN interface — the
    // warning assertions above hold regardless).
    const alsoLines = gui.out().split("\n").filter((l) => l.includes("also at http://"));
    for (const line of alsoLines)
      assert.match(line, /^\s*also at http:\/\/\S+:\d+\/\?token=s3cret$/);
  } finally {
    gui.kill();
  }
});

test("the gui reloads onto a newer build: closes, re-execs, re-binds the same port, and the reloaded server dies with its wrapper", async () => {
  // startGui's reload glue (`server.close(); reexecSelf();`) is the one part of the
  // self-reload story with no injected seam: self-reload.test.ts pins the watch and the
  // re-exec against fakes, but nothing proves the dashboard actually survives a redeploy —
  // a glue that skipped server.close() or re-exec'd with the wrong argv would leave every
  // operator's dashboard dead (or EADDRINUSE-crashing) after the fleet's first self-redeploy.
  // The watch arms only for a build compiled from the checkout it serves, so this stands up a
  // scratch self-hosted install — a fixture repo whose dist/ is a copy of this build's
  // compiled tree, stamped with the fixture's own commit — runs the real CLI from that copy,
  // restamps the copy with a second real commit the way redeploy.ts's swap does, and requires
  // the same port to come back serving the new stamp.
  //
  // Never this checkout's own dist/: a suite run in the checkout a live `tumwater gui` serves
  // from re-exec'd that dashboard onto whatever the test wrote there (BUGS.md 2026-09-29).
  const repo = makeRepo();
  await initProject(repo, "cli gui self-reload");
  // The CLI serves the repo's toplevel as git spells it (realpath: /private/var/… on macOS),
  // and the watch compares the stamp's root against exactly that.
  const root = sh(repo, "git", "rev-parse", "--show-toplevel");
  const dist = path.join(root, "dist");
  fs.cpSync(path.join(distDir(), "src"), path.join(dist, "src"), { recursive: true });
  const stampDist = (sha: string) =>
    fs.writeFileSync(buildInfoPath(dist), JSON.stringify({ sha, builtAt: Date.now(), root }));
  const startupSha = sh(repo, "git", "rev-parse", "HEAD");
  stampDist(startupSha);

  // Detached so the kill below reaches the whole tree: the re-exec'd server is a child of
  // the first one (which exits only after it), and both share the spawned process group.
  const port = await freeTcpPort();
  const env = { ...process.env };
  delete env[SUPERVISED_ENV];
  const child = spawn(process.execPath, [path.join(dist, "src", "cli.js"), "gui", "--port", String(port)], {
    cwd: root,
    env: exitWithOwnerEnv(env), // the re-exec'd server inherits the owner watch too
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (d) => (out += d));
  child.stderr?.on("data", (d) => (out += d));
  const banners = () => out.split(`tumwater gui at http://127.0.0.1:${port}`).length - 1;

  try {
    await waitFor(() => banners() >= 1, "the first gui banner");
    const first = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.equal(first.serverBuildSha, startupSha, "the first server reports the startup stamp");

    // The redeploy: main moves and its build is stamped into dist/ in place, like redeploy.ts's
    // swap. The watch polls within a second, confirms the stamp names a commit of this repo,
    // then the glue closes and re-execs.
    sh(repo, "git", "commit", "--allow-empty", "-q", "-m", "the next build");
    const reloadedSha = sh(repo, "git", "rev-parse", "HEAD");
    stampDist(reloadedSha);
    await waitFor(() => banners() >= 2, "the re-exec'd server's banner on the same port");
    let reloaded: { serverBuildSha?: string | null } | undefined;
    for (let i = 0; i < 50; i++) {
      try {
        const body = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
        if (body.serverBuildSha === reloadedSha) {
          reloaded = body;
          break;
        }
      } catch {
        // The re-exec'd server is still binding; retry.
      }
      await sleep(100);
    }
    assert.ok(reloaded, `a server on port ${port} reports the reloaded stamp`);
    assert.match(
      (await (await fetch(`http://127.0.0.1:${port}/`)).text()),
      /<title>tumwater<\/title>/,
      "the reloaded server still serves the dashboard",
    );

    // The wrapper — the process the operator started, now the reloaded server's supervisor —
    // dies outright, forwarding nothing: the server it supervised must free the port and exit
    // (watchReloadSupervisor) rather than serve on at PPID 1.
    const reloadedPid = Number(
      execFileSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" }).trim().split("\n")[0],
    );
    assert.ok(reloadedPid > 0, "the wrapper supervises the reloaded server");
    process.kill(child.pid as number, "SIGKILL");
    const goneDeadline = Date.now() + 15_000;
    while (pidAlive(reloadedPid) && Date.now() < goneDeadline) await sleep(100);
    assert.equal(pidAlive(reloadedPid), false, "the reloaded server exited with its supervisor");
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/status`), "nothing serves the port any more");
  } finally {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone (or no longer a group leader) — the direct kill below still applies.
    }
    child.kill("SIGKILL");
  }
});

// ── cmdGui's policy, pinned in-process through its seams ────────────────────────────────
// The spawn tests above exercise cmdGui end to end, but a killed child's coverage never
// reaches the suite's report, so the banner's exact wording, the LAN announcement block, and
// the busy-port message stayed invisible to the coverage table. cmdGui takes seams (the same
// discipline runTui's TuiSeams established): these tests pin that policy in-process.

/** A startGui seam stub that records the arguments and resolves without listening. */
function startRecorder(started: Array<{ port: number; allInterfaces: boolean; token: string }>) {
  return async (_root: string, port: number, allInterfaces?: boolean, token?: string) => {
    started.push({ port, allInterfaces: allInterfaces ?? false, token: token ?? "" });
    return undefined as unknown as http.Server;
  };
}

const QUIET_SERVE: GuiSeams["serve"] = async () => {}; // resolves instead of serving until Ctrl+C

 test("cmdGui prints the localhost banner and starts the server with the parsed flags", async () => {
  const repo = makeRepo();
  await initProject(repo, "cmdGui banner seams");
  const lines: string[] = [];
  const started: Array<{ port: number; allInterfaces: boolean; token: string }> = [];

  // An explicit --port is parsed and passed through; no token, localhost only.
  await cmdGui(repo, ["--port", "7181"], {
    startGui: startRecorder(started),
    say: (t) => lines.push(t),
    serve: QUIET_SERVE,
  });
  assert.deepEqual(started, [{ port: 7181, allInterfaces: false, token: "" }]);
  assert.deepEqual(lines, ["tumwater gui at http://127.0.0.1:7181 — Ctrl+C to stop"]);

  // No --port at all: the documented 7180 default, still localhost-only.
  lines.length = 0;
  started.length = 0;
  await cmdGui(repo, [], {
    startGui: startRecorder(started),
    say: (t) => lines.push(t),
    serve: QUIET_SERVE,
  });
  assert.deepEqual(started, [{ port: 7180, allInterfaces: false, token: "" }]);
  assert.deepEqual(lines, ["tumwater gui at http://127.0.0.1:7180 — Ctrl+C to stop"]);
});

test("cmdGui --all-interfaces names the LAN URLs and the exposure warning, token or not", async () => {
  const repo = makeRepo();
  await initProject(repo, "cmdGui lan seams");
  const started: Array<{ port: number; allInterfaces: boolean; token: string }> = [];
  const lan = () => ["192.168.1.50", "10.0.0.2"]; // the machine's addresses, as the real filter would yield

  // Without a token the LAN URLs carry no suffix and the warning says the dashboard is open.
  const open: string[] = [];
  await cmdGui(repo, ["--all-interfaces"], {
    startGui: startRecorder(started),
    lanAddresses: lan,
    say: (t) => open.push(t),
    serve: QUIET_SERVE,
  });
  assert.deepEqual(open, [
    "tumwater gui at http://127.0.0.1:7180 — Ctrl+C to stop",
    "             also at http://192.168.1.50:7180",
    "             also at http://10.0.0.2:7180",
    "listening on ALL interfaces — no auth; anyone reaching it can prompt the director",
  ]);

  // With a token every printed URL — banner and LAN lines alike — carries the ?token= suffix
  // an operator can open directly, and the warning names the token as the gate.
  const gated: string[] = [];
  await cmdGui(repo, ["--all-interfaces", "--token", "s3cret"], {
    startGui: startRecorder(started),
    lanAddresses: lan,
    say: (t) => gated.push(t),
    serve: QUIET_SERVE,
  });
  assert.deepEqual(gated, [
    "tumwater gui at http://127.0.0.1:7180/?token=s3cret — Ctrl+C to stop",
    "             also at http://192.168.1.50:7180/?token=s3cret",
    "             also at http://10.0.0.2:7180/?token=s3cret",
    "listening on ALL interfaces — token-protected; prompting the director requires the token",
  ]);
  assert.deepEqual(started.slice(-1), [{ port: 7180, allInterfaces: true, token: "s3cret" }]);
});

test("cmdGui turns a taken port into the friendly port-in-use error and rethrows the rest", async () => {
  const repo = makeRepo();
  await initProject(repo, "cmdGui busy port seams");

  // EADDRINUSE — the common case — becomes the hint that names the fix, thrown so cli.ts's
  // main catch renders it as the same `tumwater: …` line and exit 1 a direct fail() printed.
  const inUse = Object.assign(new Error("listen EADDRINUSE: address already in use"), { code: "EADDRINUSE" });
  await assert.rejects(
    cmdGui(repo, ["--port", "7181"], { startGui: () => Promise.reject(inUse), serve: QUIET_SERVE }),
    {
      message:
        "port 7181 is already in use — stop that process or pick another port with `tumwater gui --port <n>`",
    },
  );

  // EACCES — the privileged-port case — becomes its own hint, not the port-in-use one:
  // the fixes differ (pick an unprivileged port, not stop that process).
  const eacces = Object.assign(new Error("listen EACCES: permission denied"), { code: "EACCES" });
  await assert.rejects(
    cmdGui(repo, [], { startGui: () => Promise.reject(eacces), serve: QUIET_SERVE }),
    {
      message:
        "port 7180 could not be opened (permission denied) — ports below 1024 need root; pick an unprivileged port with `tumwater gui --port <n>`",
    },
  );

  // Any rarer listen failure passes through untouched — the CLI shows the raw error.
  const eio = Object.assign(new Error("listen EIO: i/o error"), { code: "EIO" });
  await assert.rejects(
    cmdGui(repo, [], { startGui: () => Promise.reject(eio), serve: QUIET_SERVE }),
    (err: unknown) => err === eio,
  );
});

test("gui stops on Ctrl+C: SIGINT ends the serve loop instead of wedging the terminal", async () => {
  // The banner promises "Ctrl+C to stop"; the serve loop relies on node's default SIGINT
  // disposition (cmdGui's serve promise never resolves on its own). A regression that added a
  // SIGINT handler which swallows the signal — or a server whose open handles keep the loop
  // alive after the default termination — would leave the operator's terminal wedged; this
  // bounds it: the child must actually exit once the signal lands, within the exitCode
  // helper's own timeout (a hung gui resolves null and fails the assertion).
  const repo = makeRepo();
  await initProject(repo, "cli gui sigint");

  const port = await freeTcpPort();
  const gui = spawnCli(repo, ["gui", "--port", String(port)]);
  await gui.waitFor((b) => b.includes(`tumwater gui at http://127.0.0.1:${port}`), "the banner");
  gui.child.kill("SIGINT");
  // A default-disposition SIGINT death closes with code null and signal SIGINT — so the
  // timeout, not a null code, is the failure (a hung gui rejects here; a clean stop resolves).
  const stopped = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gui kept running 15s after SIGINT — Ctrl+C no longer stops it")), 15_000);
    gui.child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.equal(stopped.signal, "SIGINT");
  // The server is down with the process: the port must not keep answering.
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/`));
});
