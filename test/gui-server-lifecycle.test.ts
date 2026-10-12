import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { initProject } from "../src/init/init.js";
import { readEvents } from "../src/events/event-read.js";
import { readBuildInfo, type BuildInfo } from "../src/build/build-info.js";
import { startGui } from "../src/gui/gui-server.js";
import { DASHBOARD_CHILD_ENV } from "../src/redeploy/self-reload.js";
import { startLocalGui } from "./fixtures/gui-fixtures.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { sleep, waitFor } from "./helpers/wait.js";

// The dashboard server's lifecycle: the reload supervisor watch (a dead supervisor or a
// newer build on disk tears the server down) and the post-listen error handler's
// best-effort recording. Extracted from the former gui-server.test.ts (2026-10-12).

test("a reloaded gui whose reload supervisor dies closes its server and exits", async () => {
  // The orphan wiring: a supervised child (the mark names its supervisor) whose supervisor was
  // SIGKILLed frees its port and exits instead of serving on at PPID 1. The supervisor watch's
  // parent pid and the exit are injected, so nothing is reparented or really exited.
  const repo = makeRepo();
  await initProject(repo, "gui supervisor-death teardown");
  let ppid = 4242;
  const exits: number[] = [];
  const server = await startGui(repo, 0, false, "", {
    isSelfHostedImpl: async () => false,
    supervisor: { env: { [DASHBOARD_CHILD_ENV]: "4242" }, ppid: () => ppid, intervalMs: 5 },
    exit: (code) => {
      exits.push(code);
    },
  });
  try {
    await sleep(40);
    assert.equal(server.listening, true, "under a live supervisor the gui keeps serving");
    ppid = 1; // the supervisor died outright and the child reparented
    await waitFor(() => exits.length > 0, "the supervisor watch fires", 5000);
    assert.deepEqual(exits, [0], "the orphaned child exits, once");
    assert.equal(server.listening, false, "the server closed before the exit");
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
    await sleep(60);
    assert.equal(reexecs, 0, "an unchanged dist stamp never reloads");
    assert.equal(server.listening, true, "the server is still serving the current build");

    // A redeploy swaps dist/ under the serving process: the watch closes the server — the
    // re-exec's fresh process takes the port — and re-execs. Firing latches: a stamp that
    // changes again while the old process still winds down must not re-exec twice.
    disk = { ...startup, sha: `${startup.sha}-newer` };
    await waitFor(() => reexecs > 0, "the reload watch fires on a newer dist stamp", 5000);
    assert.equal(server.listening, false, "the server closed before the re-exec");
    disk = { ...startup, sha: "third-sha" };
    await sleep(60);
    assert.equal(reexecs, 1, "the reload fires at most once per process");
  } finally {
    server.close();
  }
});

test("a post-listen server error is recorded, not swallowed by the listen-time reject", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui post-listen error test");
  const { server } = await startLocalGui(repo);
  try {
    // The listen-time `once("error", reject)` would fire here against an already-settled
    // promise and vanish, leaving a dashboard that still holds its port but no longer
    // serves. The fix replaces it once listening with a handler that records a warning, so
    // the failure is visible in the feed.
    server.emit("error", new Error("EMFILE: accept failed"));
    const warning = readEvents(repo).find(
      (e) => e.type === "warning" && /dashboard server error/.test(String(e.message ?? "")),
    );
    assert.ok(warning, "the post-listen error was recorded as a warning event");
    assert.match(String(warning.message ?? ""), /EMFILE/);
  } finally {
    server.close();
  }
});

test("a post-listen server error cannot crash the dashboard when the event log is unwritable", async (t) => {
  const repo = makeRepo();
  await initProject(repo, "gui post-listen error unwritable log test");
  const { server } = await startLocalGui(repo);
  try {
    // The post-listen handler records the failure through warnEvent, whose append can itself
    // fail (ENOSPC, EACCES on the log under disk pressure). A throw out of a Node 'error'
    // listener is an uncaught exception that kills the process, so the recording must be
    // best-effort: a problem writing the event log must not turn a recoverable socket error
    // into a dead dashboard.
    t.mock.method(fs, "appendFileSync", () => {
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    });
    assert.doesNotThrow(() => server.emit("error", new Error("EMFILE: accept failed")));
  } finally {
    t.mock.restoreAll();
    server.close();
  }
});
