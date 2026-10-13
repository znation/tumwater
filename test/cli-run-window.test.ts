import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { logEvent } from "../src/events/events.js";
import { initProject } from "../src/init/init.js";
import { readEvents } from "../src/events/event-read.js";
import { orchestratorStatePath } from "../src/paths.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { fakePi } from "./fakes/fake-pi.js";
import { exitCode, spawnCli } from "./helpers/cli-harness.js";
import { sleep } from "./helpers/wait.js";
import { onlyCleanRole } from "./helpers/run-live-harness.js";

// `tumwater run`'s two live run modes: the `--for` bounded window that stops itself at its
// deadline, and `--gui`, which serves the browser dashboard from the supervisor so it outlives
// orchestrator generations. Both boot a real fleet; the pre-boot guards live in
// cli-run-guards.test.ts, the lifecycle and shutdown tests in cli-run-shutdown.test.ts, the
// terminal-Ctrl+C handling in cli-run-sigint.test.ts, the forced second-Ctrl+C exit in
// cli-run-force-exit.test.ts, and the scoped --once round in cli-run-once.test.ts.

/** `run --gui`'s default dashboard port. The live test skips when it is already taken, because
 * a second binder would fail to bind and prove nothing about `run --gui`. */
const DASHBOARD_PORT = 7180;

/** True when nothing is listening on `port` on loopback — the live test can then let `run --gui`
 * bind it and can confirm it is free again after teardown. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

/** One GET of a dashboard path, resolved once the body is fully read; a connection error or a
 * stalled response rejects so the caller fails instead of hanging. */
function getDashboardBody(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, timeout: 5_000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("dashboard request timed out")));
  });
}

/** Poll `GET /` until the dashboard answers or the deadline passes, so a boot that printed its
 * banner but has not bound yet does not fail the test on the first try. */
async function waitForDashboard(port: number, ms = 30_000): Promise<string> {
  const deadline = performance.now() + ms;
  for (;;) {
    try {
      return await getDashboardBody(port, "/");
    } catch {
      if (performance.now() > deadline) throw new Error(`dashboard on port ${port} never answered`);
      await sleep(200);
    }
  }
}

/** Poll until `port` is bindable again, or the deadline passes. */
async function waitForPortFree(port: number, ms = 15_000): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (performance.now() <= deadline) {
    if (await portFree(port)) return true;
    await sleep(200);
  }
  return false;
}

// `run --for <duration>`: the windowed run boots the daemon-shaped fleet, stops itself at the
// deadline through the same graceful stop a Ctrl+C runs, prints the deadline line and the
// summary, and exits 0 — no operator signal needed.
test("run --for boots, stops itself at the deadline, and prints the summary", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run for window");

  onlyCleanRole(repo);
  // A tick that ended before the window opened must not be counted in the window's summary.
  logEvent(repo, { ts: Date.now() - 3_600_000, loop: "ghost", type: "tick_end", tick: 1, result: "changed" } as never);
  const restore = fakePi("exit 0");
  const spawnedAt = Date.now();
  const s = spawnCli(repo, ["run", "--for", "3s"]);
  try {
    let stopsAt: unknown;
    const polled = Date.now() + 2500;
    while (stopsAt === undefined && Date.now() < polled) {
      try {
        stopsAt = JSON.parse(fs.readFileSync(orchestratorStatePath(repo), "utf8")).stopsAt;
      } catch { /* not written yet, or torn */ }
      if (stopsAt === undefined) await sleep(50);
    }
    assert.equal(typeof stopsAt, "number", "the info file publishes the window's deadline");
    assert.ok(Math.abs((stopsAt as number) - (spawnedAt + 3000)) < 5000, `stopsAt ${String(stopsAt)} near spawn + 3s`);
    const code = await exitCode(s.child);
    assert.equal(code, 0, `expected clean exit at the deadline; output so far:\n${s.out()}`);
    assert.match(s.out(), /tumwater running on branch main · for 3s ·/);
    assert.match(s.out(), /deadline reached — stopping/);
    assert.match(s.out(), /stopping — waiting for in-flight ticks/);
    assert.match(s.out(), /for 3s: \d+ ticks?/);
    assert.ok(!s.out().includes("ghost"), `a pre-window tick leaked into the summary:\n${s.out()}`);
    assert.ok(!s.out().split("\n").some((l) => l.startsWith("once:")), "no once: line under --for");
    assert.ok(!fs.existsSync(orchestratorStatePath(repo)), "orchestrator info file removed");
    // A deadline stop the run asked for is not the fleet dying: no supervisor_exit trace.
    assert.equal(eventsOfType(repo, "supervisor_exit").length, 0,
      `a deadline stop must not be recorded as a fleet death:\n${JSON.stringify(readEvents(repo))}`);
  } finally {
    s.kill();
    restore();
  }
});

// `run --gui`: one command boots the fleet and serves the browser dashboard (the `tumwater gui`
// server on its defaults) from the supervisor, so the dashboard outlives orchestrator
// generations and dies with the fleet. This is the only test that exercises the wiring end to
// end, so it skips cleanly (t.skip, not an early return that would read as a pass) when port 7180
// is already taken by another dashboard.
test("run --gui serves the dashboard from the supervisor and frees the port on SIGTERM", async (t) => {
  if (!(await portFree(DASHBOARD_PORT))) {
    t.skip(`port ${DASHBOARD_PORT} is already in use; skipping the live run --gui test`);
    return;
  }
  const repo = makeRepo();
  await initProject(repo, "cli run gui");
  onlyCleanRole(repo);
  const restore = fakePi("exit 0");
  const s = spawnCli(repo, ["run", "--gui"]);
  try {
    await s.waitFor(
      (out) =>
        out.includes("tumwater running on branch main") &&
        out.includes(`tumwater gui at http://127.0.0.1:${DASHBOARD_PORT}`),
      "the run banner and the dashboard banner",
    );
    const body = await waitForDashboard(DASHBOARD_PORT);
    assert.match(body, /tumwater/i, `GET / serves the tumwater page; body starts: ${body.slice(0, 120)}`);

    // SIGTERM reaches the supervisor alone; it forwards to the orchestrator generation and
    // aborts the dashboard, and both must be gone when the supervisor exits.
    s.child.kill("SIGTERM");
    const code = await exitCode(s.child);
    assert.equal(code, 0, `expected a clean supervisor exit after SIGTERM; output so far:\n${s.out()}`);
    assert.ok(
      await waitForPortFree(DASHBOARD_PORT),
      `the dashboard port must be free after the supervisor exits; output so far:\n${s.out()}`,
    );
  } finally {
    s.kill();
    restore();
  }
});
