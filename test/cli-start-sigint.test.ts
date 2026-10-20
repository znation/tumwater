import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { initProject } from "../src/init/init.js";
import { readEvents } from "../src/events/event-read.js";
import { orchestratorStatePath } from "../src/paths.js";
import { readJson } from "./helpers/json-read.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { fakePi } from "./fakes/fake-pi.js";
import { exitCode } from "./helpers/cli-harness.js";
import { sleep } from "./helpers/wait.js";
import { onlyCleanRole, withRunningTeam } from "./helpers/start-live-harness.js";

// A terminal Ctrl+C reaches BOTH processes (same foreground group), so `run` splits the
// handling: the supervisor's SIGINT handler only marks stopping (it must not forward or abort,
// or a plain `kill -INT` of the supervisor would tear down a team whose orchestrator never
// saw the signal), while the orchestrator generation's own handler runs the graceful stop
// (announce, abort in-flight ticks) and exits cleanly. These two tests pin that split end to
// end. The forced second Ctrl+C, which must outwait terminateChild's 10 s SIGKILL grace, has
// its own file (cli-start-force-exit.test.ts); the rest of the running-team lifecycle and
// SIGTERM shutdown live in cli-start-shutdown.test.ts.

test("run survives a SIGINT aimed at the supervisor alone and still stops on SIGTERM", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run sigint");

  onlyCleanRole(repo);
  await withRunningTeam(repo, fakePi("exit 0"), async (s) => {
    // SIGINT to the supervisor alone: it marks stopping but must not touch the child.
    s.child.kill("SIGINT");
    await sleep(3000); // past a poll cycle; a forwarding regression would be done by now
    assert.equal(s.child.exitCode, null, "the supervisor must keep running after a SIGINT aimed at it alone");
    assert.ok(
      fs.existsSync(orchestratorStatePath(repo)),
      `SIGINT to the supervisor must not tear down the team; output so far:\n${s.out()}`,
    );
    const info = readJson(orchestratorStatePath(repo)) as { pid: number };
    let alive = true;
    try {
      process.kill(info.pid, 0);
    } catch {
      alive = false; // ESRCH: the orchestrator died — it never received a signal.
    }
    assert.ok(alive, `orchestrator pid ${info.pid} died after a supervisor-only SIGINT`);

    // SIGTERM still tears everything down cleanly (forwarded to the child).
    s.child.kill("SIGTERM");
    const code = await exitCode(s.child);
    assert.equal(code, 0, `expected clean exit after SIGTERM; output so far:\n${s.out()}`);
    assert.match(s.out(), /stopping — finishing current runs/);
    assert.ok(!fs.existsSync(orchestratorStatePath(repo)), "orchestrator info file removed");
  });
});

test("a SIGINT reaching the orchestrator generation stops the team cleanly", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run child sigint");

  onlyCleanRole(repo);
  await withRunningTeam(repo, fakePi("exit 0"), async (s) => {
    const info = readJson(orchestratorStatePath(repo)) as { pid: number };

    // SIGINT straight to the orchestrator generation: the graceful stop path (announce, abort).
    process.kill(info.pid, "SIGINT");
    const code = await exitCode(s.child);
    assert.equal(code, 0, `expected clean exit after the generation's SIGINT; output so far:\n${s.out()}`);
    assert.match(s.out(), /stopping — finishing current runs/,
      "the generation announces the graceful stop");
    assert.ok(!fs.existsSync(orchestratorStatePath(repo)), "orchestrator info file removed");
    // A stop the operator asked for is not the team dying: no supervisor_exit trace.
    assert.equal(eventsOfType(repo, "supervisor_exit").length, 0,
      `a clean Ctrl+C must not be recorded as a team death:\n${JSON.stringify(readEvents(repo))}`);
  });
});
