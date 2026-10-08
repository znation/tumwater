import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { spawnCli } from "./cli-harness.js";
import { sleep } from "./helpers/wait.js";

// The spawn helper's readiness wait is the seam every live-CLI test leans on, so its deadline
// lives here rather than being re-derived per test. test/helpers/wait.ts's waitFor reads its deadline
// off performance.now() (monotonic); spawnCli.waitFor must do the same: a deadline read off
// Date.now() is spent by any wall-clock jump — a host sleep mid-tick is the one the gate sees —
// and a cold-start wait with budget left then times out against a child that printed nothing.
// That is the shape of the 2026-10-07 gate timeout on "gui --all-interfaces prints the reachable
// LAN URLs and serves until killed" (BUGS.md).

test("spawnCli.waitFor keeps its deadline on a clock a Date jump cannot spend", async (t) => {
  // A real child so waitFor's captured `started` is read from live time before the jump; an
  // unknown command exits at once without ever writing stdout, so the predicate stays false.
  const s = spawnCli(tmpdir(), ["definitely-not-a-command"]);
  try {
    // Call waitFor first: it captures its deadline synchronously. Then jump Date.now a day
    // forward — the wall clock's own idea of a host sleep — while performance.now() (and the
    // real 2 s budget) stay put. A Date.now()-based deadline is spent by the jump and rejects
    // on the first poll; a monotonic one keeps waiting.
    const wait = s.waitFor(() => false, "a line the child never prints", 2_000);
    const realNow = Date.now();
    t.mock.method(Date, "now", () => realNow + 86_400_000);

    const settled = wait.then(
      () => "settled",
      () => "settled",
    );
    assert.equal(await Promise.race([settled, sleep(800).then(() => "pending")]), "pending", "a Date jump must not spend the wait's deadline");
    await assert.rejects(wait, /timed out waiting for a line the child never prints/);
  } finally {
    s.kill();
  }
});
