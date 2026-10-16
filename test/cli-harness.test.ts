import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { spawnCli } from "./helpers/cli-harness.js";
import { sleep } from "./helpers/wait.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { initProject } from "../src/init/init.js";

// The spawn helper's readiness wait is the seam every live-CLI test leans on, so its deadline
// lives here rather than being re-derived per test. test/helpers/wait.ts's waitFor reads its
// deadline
// off performance.now() (monotonic); spawnCli.waitFor must do the same: a deadline read off
// Date.now() is spent by any wall-clock jump — a host sleep mid-tick is the one the gate sees —
// and a cold-start wait with budget left then times out against a child that printed nothing.
// That is the shape of the 2026-10-07 gate timeout on "gui --all-interfaces prints the reachable
// LAN URLs and serves until killed" (BUGS.md).

test("spawnCli.waitFor keeps its deadline on a clock a Date jump cannot spend", async (t) => {
  // A live child so waitFor's captured `started` is read from live time before the jump and the
  // child outlasts the wait: `logs -f` in a fresh project idles and prints no line the
  // predicate wants.
  const repo = makeRepo();
  await initProject(repo, "cli harness deadline");
  const s = spawnCli(repo, ["logs", "-f"]);
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

test("spawnCli.waitFor rejects as soon as the child exits, naming its exit status and stderr", async () => {
  // An unknown command exits non-zero at once with a usage error on stderr. The wait must not
  // poll out its 60 s budget against a dead child and print an empty buffer (BUGS.md
  // 2026-10-16).
  const s = spawnCli(tmpdir(), ["definitely-not-a-command"]);
  try {
    const started = Date.now();
    await assert.rejects(s.waitFor(() => false, "a banner"), (err: Error) => {
      assert.match(err.message, /the child exited \(code [1-9]\d*\) before a banner/);
      assert.match(err.message, /stderr:\n[\s\S]*\S/, "stderr is carried in the message");
      return true;
    });
    assert.ok(Date.now() - started < 20_000, "rejected on exit, not at the deadline");
  } finally {
    s.kill();
  }
});
