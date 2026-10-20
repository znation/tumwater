import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { readEvents } from "../src/events/event-read.js";
import { orchestratorStatePath } from "../src/paths.js";
import { readJson } from "./helpers/json-read.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakePi } from "./fakes/fake-pi.js";
import { exitCode } from "./helpers/cli-harness.js";
import { sleep, waitForFile } from "./helpers/wait.js";
import { onlyCleanRole, withRunningTeam } from "./helpers/start-live-harness.js";

// The forced second Ctrl+C, the one Ctrl+C test that must outwait a grace: the graceful
// terminal-Ctrl+C handling (supervisor-only and generation SIGINT) is pinned in
// cli-start-sigint.test.ts; the forced second Ctrl+C lives here alone. It is the one test in
// the run-live family that must outwait terminateChild's 10 s SIGTERM → SIGKILL grace — the
// detached pipe-holder it needs to keep the stop in flight until the second signal — so it is
// split into its own file rather than serializing every faster lifecycle test behind that wait.

test("a second Ctrl+C forces the orchestrator generation out at once", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run double sigint");

  onlyCleanRole(repo);
  // The graceful stop must still be pending when the second Ctrl+C lands: with an instant pi
  // nothing is in flight, the first stop finishes before the second, and the second kill hits
  // a gone pid (ESRCH, CI 2026-10-01). This pi ignores the abort's SIGTERM, and the detached
  // `sleep` it leaves behind holds pi's stdout pipe open, so terminateChild's 10 s SIGKILL can
  // reap pi without ending the in-flight tick — the graceful stop stays pending until the
  // second Ctrl+C forces the exit (BUGS.md 2026-10-07). Waiting for the first stop's
  // announcement alone still raced that 10 s grace against a loaded host's scheduling; the
  // pipe holder removes the race. The forced exit skips the teardown, so the test reaps pi's
  // group and the holder itself.
  const scratch = tmpdir("double-sigint-");
  const started = path.join(scratch, "pi-pid");
  const holder = path.join(scratch, "holder-pid");
  // `env: {}` is deliberate: the holder must not carry TUMWATER_RUN, or runPi's exit sweep
  // would kill it and release the pipe again. `stdio: ["ignore", 1, 2]` inherits pi's stdout
  // pipe; `detached: true` puts the holder in its own group, out of reach of pi's group sweep.
  const hold =
    `const{spawn}=require("child_process"),fs=require("fs");` +
    `const c=spawn("sleep",["120"],{detached:true,stdio:["ignore",1,2],env:{}});` +
    `fs.writeFileSync(${JSON.stringify(holder)},String(c.pid));c.unref();`;
  const reap = (file: string): void => {
    try {
      const pid = Number(fs.readFileSync(file, "utf8"));
      if (pid > 0) process.kill(-pid, "SIGKILL"); // Never kill(-0): that is this test's own group.
    } catch {
      // Not written yet or already gone.
    }
  };
  try {
    await withRunningTeam(
      repo,
      fakePi(`trap '' TERM; echo $$ > '${started}'; ${JSON.stringify(process.execPath)} -e '${hold}'; sleep 300`),
      async (s) => {
        const info = readJson(orchestratorStatePath(repo)) as { pid: number };
        await waitForFile(started);
        await waitForFile(holder);
        s.child.once("exit", () => {
          reap(started);
          reap(holder);
        });

        // The first Ctrl+C starts the graceful stop; the second must not queue behind it —
        // the operator pressed it to force the issue, so the generation exits 130 at once.
        // The second waits for the first handler's announcement, not a fixed gap: signals do
        // not queue, so two SIGINTs sent before a loaded generation is scheduled coalesce into
        // one and the run takes the graceful path (the `expected the forced exit code` flakes,
        // BUGS.md 2026-09-30).
        process.kill(info.pid, "SIGINT");
        await s.waitFor((out) => out.includes("stopping — finishing current runs"), "the first Ctrl+C's stop");
        // Wait out terminateChild's SIGTERM → SIGKILL grace: the moment a loaded host's
        // scheduling used to let the old test's graceful stop finish under it. The holder
        // keeps the tick pending past pi's death, so the second Ctrl+C still finds the stop in
        // flight. A bounded wait keeps a wedged harness from hanging the test.
        const piPid = Number(fs.readFileSync(started, "utf8"));
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          try {
            process.kill(piPid, 0);
          } catch {
            break; // pi was SIGKILLed and reaped: the grace has elapsed.
          }
          await sleep(50);
        }
        // A beat past pi's death: without the holder the stop settles here and the generation
        // is gone before the second Ctrl+C; the holder keeps it in flight for the signal.
        await sleep(250);
        process.kill(info.pid, "SIGINT");
        const code = await exitCode(s.child);
        assert.equal(code, 130, `expected the forced exit code; output so far:\n${s.out()}`);
        // The generation died unasked (a forced exit, not a clean stop): the supervisor records
        // the death and hands the operator the child's code back.
        const down = eventsOfType(repo, "supervisor_exit");
        assert.equal(down.length, 1, `expected one supervisor_exit event:\n${JSON.stringify(readEvents(repo))}`);
        assert.equal(down[0]?.code, 130);
      },
    );
  } finally {
    reap(started);
    reap(holder);
  }
});
